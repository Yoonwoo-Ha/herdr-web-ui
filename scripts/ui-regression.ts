/** Real-browser regressions against owned herdr panes. Run after `bun run build`. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { WorkspaceCreated, WorktreeOpened } from "../shared/protocol.ts";
import { checkPushSettings } from "./push-settings-regression.ts";
import { checkWakeLock } from "./wake-lock-regression.ts";
import { checkNeedsInput } from "./needs-input-regression.ts";
import { checkSecretInput } from "./secret-input-regression.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkStatusUsage, checkUsageMeters } from "./usage-regression.ts";
import { checkNotificationStartup } from "./notification-startup-regression.ts";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { checkMobileTabs } from "./mobile-tabs-regression.ts";
import { checkTerminalFileInput } from "./terminal-file-input-regression.ts";
import { checkTerminalInput } from "./terminal-input-regression.ts";
import { checkDefaultView } from "./default-view-regression.ts";
import { checkComposerReconnect } from "./composer-reconnect-regression.ts";
import { checkDroplet } from "./droplet-regression.ts";
import { checkAlertSound } from "./alert-sound-regression.ts";
import { checkChatKeepsTerminalSize, checkPaneSwitchKeepsTerminalSize } from "./chat-size-regression.ts";
import { checkCommandBackspace } from "./terminal-command-backspace-regression.ts";
import { checkUpdateNotice } from "./update-notice-regression.ts";
import { UsageService } from "../server/usage.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-web-ui-browser-")));
const workspaces: string[] = [];
const worktreeWorkspaces: string[] = [];
// the repository the worktree step makes, for the cleanup to find what the step made
let repo: string | null = null;
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
    // only the first load: a reload must keep what Settings stored, such as the sidebar grouping
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
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
  const sockets: import("playwright-core").WebSocket[] = [];
  const inputs: Array<{ pane_id: string; text: string }> = [];
  page.on("websocket", (socket) => {
    sockets.push(socket);
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
  await checkTerminalFileInput(page, sockets[0]!);
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
  // xterm collapses Shift+Enter into CR unless the terminal supplies a newline chord.
  // Check actual browser key events and the frames sent to an owned pane, including keyup.
  for (const [shortcut, expected] of [
    ["Enter", "\r"],
    ["Shift+Enter", "\x1b\r"],
    ["Alt+Enter", "\x1b\r"],
  ]) {
    await terminalInput.focus();
    const beforeEnter = inputs.length;
    await page.keyboard.press(shortcut!);
    await until(() => inputs.length > beforeEnter, `terminal ${shortcut}`);
    await page.waitForTimeout(NO_SEND_WAIT_MS);
    assert.deepEqual(inputs.slice(beforeEnter).map(({ pane_id, text }) => ({ pane_id, text })),
      [{ pane_id: paneA, text: expected }], `${shortcut} must send its sequence exactly once`);
  }
  // A composition commit belongs to xterm/IME; the custom binding must not replace it.
  for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    const beforeIme = inputs.length;
    await terminalInput.dispatchEvent("keydown", {
      key: "Enter", code: "Enter", shiftKey: true, ...composition, bubbles: true, cancelable: true,
    });
    await page.waitForTimeout(NO_SEND_WAIT_MS);
    assert.equal(inputs.slice(beforeIme).some(({ text }) => text === "\x1b\r"), false,
      "IME commits must not receive the custom Shift+Enter sequence");
  }
  // compositionend queues its send for the next timer. A following non-composing
  // Shift+Enter must let xterm flush that commit before sending the newline.
  await terminalInput.focus();
  const beforeCommittedIme = inputs.length;
  await terminalInput.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "";
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "한";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
    // An earlier composition update has established the committed span.
    await new Promise((resolve) => setTimeout(resolve, 0));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
    const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13,
      shiftKey: true, isComposing: false, bubbles: true, cancelable: true };
    textarea.dispatchEvent(new KeyboardEvent("keydown", enter));
    textarea.dispatchEvent(new KeyboardEvent("keyup", enter));
  });
  await until(() => inputs.length >= beforeCommittedIme + 2, "IME commit followed by Shift+Enter");
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.deepEqual(inputs.slice(beforeCommittedIme).map(({ pane_id, text }) => ({ pane_id, text })),
    [{ pane_id: paneA, text: "한" }, { pane_id: paneA, text: "\x1b\r" }],
    "a pending IME commit must precede Shift+Enter without a delayed duplicate");
  console.log("PASS terminal Shift+Enter sends a newline chord once and preserves Enter, Alt+Enter and IME");
  console.log("PASS pending IME commit precedes Shift+Enter without duplicate text");
  await checkCommandBackspace(browser, origin, paneA);
  // a pane shortcut switches panes and types nothing: xterm used to send ESC[1;6B / ESC[1;6A too
  const selectedTitle = () => page.locator(".pane-item.is-selected .pane-select").getAttribute("title");
  // A pane just picked shows the lens of the pane before it for a moment, and the message box
  // of that lens can take the focus back: the key waits until the terminal still has it two frames on.
  const focusTerminal = () => until(async () => {
    await terminalInput.focus();
    return page.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      resolve(document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)))));
  }, "the terminal holds the focus");
  for (const key of ["Control+Shift+ArrowDown", "Control+Shift+ArrowUp"]) {
    await focusTerminal();
    const beforeSwitch = inputs.length;
    await page.keyboard.press(key);
    await until(async () => !(await selectedTitle())?.startsWith(`${paneA} —`), `${key} leaves the pane`);
    await page.waitForTimeout(NO_SEND_WAIT_MS);
    assert.deepEqual(inputs.slice(beforeSwitch), [], `${key} must not reach a pane`);
    await page.locator(`.pane-select[title^="${paneA} —"]`).click();
    await until(async () => (await selectedTitle())?.startsWith(`${paneA} —`) === true, "back on the first pane");
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

  // Add PC lives in Settings → Remote PCs, not in the sidebar; opening it closes Settings behind it
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: "Add PC", exact: true }).count(), 0, "the sidebar has no Add PC button");
  await page.keyboard.press("Control+Shift+Comma");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Add PC", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Settings" }).count(), 0, "Add PC closes Settings");
  await page.getByRole("button", { name: "Close PC setup", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor({ state: "hidden" });
  // its trigger went with Settings: focus lands on the header's workspace-list toggle instead of nowhere
  await until(async () => await page.evaluate(() => document.activeElement?.matches(".sidebar-toggle, .drawer-toggle") ?? false), "focus returns to the workspace-list toggle after Add PC closes");
  console.log("PASS Add PC opens from Settings, and the sidebar has no top bar");

  // An update request answered while the page is hidden (a phone app sent to the background) must
  // still release the buttons: the status poll stops with the page, the request does not.
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  const idleStatus = { managed: true, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: "0.0.0", latest_version: "0.0.0", available: false, checked_at: new Date().toISOString(), blocked_reason: null, error: null };
  await page.route("**/api/updates", (route) => route.fulfill({ json: idleStatus }));
  await page.route("**/api/updates/check", async (route) => { await checkGate; await route.fulfill({ json: { ok: true } }); });
  const setPageHidden = (hidden: boolean) => page.evaluate((hidden) => {
    if (hidden) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    else delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  // the idle status poll runs every 30 s: a hide and a show restart it at once, onto the fake
  await setPageHidden(true);
  await setPageHidden(false);
  await page.keyboard.press("Control+Shift+Comma");
  const checkUpdates = page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Check for updates", exact: true });
  await checkUpdates.waitFor();
  await checkUpdates.click();
  await until(() => checkUpdates.isDisabled(), "the check is pending");
  await setPageHidden(true);
  releaseCheck();
  await page.waitForTimeout(300);
  await setPageHidden(false);
  await until(async () => !(await checkUpdates.isDisabled()), "an answer that came while hidden releases the update buttons");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.unroute("**/api/updates/check");
  await page.unroute("**/api/updates");
  console.log("PASS an update answer that arrives while the page is hidden releases the buttons");

  // the bell turns this device's alerts on, and off again (it stayed disabled once on)
  const bell = page.locator(".bell-button");
  // before the permission question is answered the bell already reads as on: in-app alerts show
  assert.equal(await bell.getAttribute("aria-label"), "Alerts on in the app only");
  assert.equal(await bell.getAttribute("aria-pressed"), "true");
  await context.grantPermissions(["notifications"], { origin });
  await bell.click();
  await until(async () => await bell.getAttribute("aria-label") !== "Alerts on in the app only", "the bell's tap takes the permission");
  assert.equal(await bell.getAttribute("aria-pressed"), "true");
  await bell.click();
  await until(async () => await bell.getAttribute("aria-pressed") === "false", "bell off");
  assert.equal(await bell.getAttribute("aria-label"), "Alerts off");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").alertsOn), false);
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null), null, "turning alerts off drops the push subscription");
  await bell.click();
  await until(async () => await bell.getAttribute("aria-pressed") === "true", "bell on again");
  console.log("PASS the bell turns alerts off and on again");

  // where notifications are blocked the bell is still there, and switches the in-app alerts
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await blocked.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(origin);
  const blockedBell = blockedPage.locator(".bell-button");
  await blockedBell.waitFor();
  assert.equal(await blockedBell.getAttribute("aria-label"), "Alerts on in the app only");
  assert.equal(await blockedBell.getAttribute("aria-pressed"), "true");
  await blockedBell.click();
  await until(async () => await blockedBell.getAttribute("aria-pressed") === "false", "blocked bell off");
  assert.equal(await blockedBell.getAttribute("aria-label"), "Alerts off");
  assert.equal(await blockedPage.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").alertsOn), false);
  await blockedBell.click();
  await until(async () => await blockedBell.getAttribute("aria-pressed") === "true", "blocked bell on again");
  assert.equal(await blockedBell.getAttribute("aria-label"), "Alerts on in the app only");
  await blocked.close();
  console.log("PASS a device that blocks notifications keeps the bell as the switch for in-app alerts");

  await checkPushSettings(browser, origin);
  await checkWakeLock(browser, origin, paneA);
  await checkNeedsInput(browser, origin, paneA);
  await checkSecretInput(browser, origin);
  await checkTerminalCopy(browser, origin);
  await checkUsageMeters(browser, origin);
  await checkNotificationStartup(browser, origin, paneA, paneB);
  await checkMobileViewport(browser, origin, paneB);
  await checkMobileTabs(browser, origin);
  await checkDefaultView(browser, origin);
  await checkComposerReconnect(browser, origin, paneB);
  await checkDroplet(browser, origin);
  await checkAlertSound(browser, origin);
  await checkChatKeepsTerminalSize(browser, origin);
  await checkPaneSwitchKeepsTerminalSize(browser, origin);
  await checkUpdateNotice(browser, origin);

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
  // the queue belongs to the chat lens: the terminal lens hides it and keeps it for the return
  const lens = page.getByRole("group", { name: "Pane view", exact: true });
  await lens.getByRole("button", { name: "Terminal", exact: true }).click();
  await until(async () => await page.locator(".composer-queue").count() === 0, "queue hidden in the terminal lens");
  await lens.getByRole("button", { name: "Chat", exact: true }).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "queue back in the chat lens");
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
  // on a wide pane the row keeps the box's column instead of running to the pane's left edge
  const quickBox = await page.locator(".composer-quick").boundingBox();
  const surfaceBox = await page.locator(".composer-surface").boundingBox();
  assert.ok(quickBox && surfaceBox);
  assert.equal(Math.round(quickBox.x), Math.round(surfaceBox.x));
  assert.equal(Math.round(quickBox.width), Math.round(surfaceBox.width));
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

  // the status line holds the agent and its state: no report action
  assert.equal(await page.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "no report action");

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

  // Every directory has a fold caret, even with one pane; opening a pane reveals its folder.
  const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: paneB, direction: "down", focus: false });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('.segmented[aria-label="Sidebar grouping"]').getByRole("button", { name: "By folder", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  const sectionB = page.locator(`.directory-group[data-directory="${join(root, "b")}"]`);
  const toggleB = sectionB.locator(".directory-header");
  await toggleB.waitFor();
  assert.equal(await page.locator(".directory-group", { has: page.locator(`.pane-select[title^="${paneA} —"]`) }).locator(".directory-header").count(), 1, "a lone pane keeps its folder header");
  await toggleB.click();
  await sectionB.locator(".directory-contents").waitFor({ state: "detached" });
  assert.equal(await toggleB.getAttribute("aria-expanded"), "false");
  await page.reload();
  await page.locator(".conn-live").waitFor();
  const foldedB = page.locator(".directory-group.is-collapsed", { has: page.locator(".directory-header[aria-expanded='false']") });
  await foldedB.waitFor();
  assert.equal(await foldedB.locator(`.pane-select[title^="${paneB} —"]`).count(), 0, "the fold survives a reload");
  await page.goto(`${origin}/?pane=${encodeURIComponent(split.pane.pane_id)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(`.pane-item.is-selected .pane-select[title^="${split.pane.pane_id} —"]`).waitFor();
  assert.equal(await page.locator(".directory-group.is-collapsed").count(), 0);
  // Status snapshots do not undo a deliberate fold of the selected folder.
  await toggleB.click();
  await sectionB.locator(".directory-contents").waitFor({ state: "detached" });
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "blocked" });
  await page.locator(`.pane-item:has(.pane-select[title^="${paneA} —"]) .badge[data-status="blocked"]`).waitFor();
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  await page.locator(`.pane-item:has(.pane-select[title^="${paneA} —"]) .badge:not([data-status="blocked"])`).waitFor();
  assert.equal(await sectionB.locator(".workspace-list").count(), 0, "a snapshot update keeps the selected pane's workspace folded");
  assert.equal(await toggleB.getAttribute("aria-expanded"), "false");
  await toggleB.click();
  await sectionB.locator(".directory-contents").waitFor();
  await herdrRpc("pane.close", { pane_id: split.pane.pane_id });
  await page.locator(`.pane-select[title^="${split.pane.pane_id} —"]`).waitFor({ state: "detached" });
  await selectPane(paneA);
  await composer.fill("draft for A");
  console.log("PASS a folder folds from its caret, stays folded across reloads, and unfolds for a pane opened inside it");

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
  await page.getByRole("button", { name: /^New workspace on / }).click();
  const dialog = page.getByRole("dialog", { name: /^New workspace/ });
  await dialog.getByLabel(/^Directory/).fill(root);
  await dialog.getByLabel(/^Name/).fill("herdr-web-ui-test-browser-created");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await until(() => createRequests === 1, "creation started");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "in-flight creation cannot be dismissed");
  assert.equal(await dialog.getByRole("button", { name: "Close dialog" }).isDisabled(), true);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
  releaseCreate();
  const created = await (await createdResponse).json() as WorkspaceCreated;
  workspaces.push(created.workspace_id);
  await dialog.waitFor({ state: "hidden" });
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "created pane selected");
  assert.equal(createRequests, 1);
  console.log("PASS session creation stays pending and opens one owned workspace");

  // A git worktree from a workspace row's ⋯ menu, as herdr's prefix+shift+g makes one: a new
  // workspace next to the repository's, selected; Open worktree… then lists it as already open.
  repo = join(root, `herdr-web-ui-test-repo-${process.pid.toString(36)}`);
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=herdr-web-ui test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  assert.equal(git("init", "-q", "-b", "main").exitCode, 0, "git init");
  writeFileSync(join(repo, "README.md"), "worktree fixture\n");
  assert.equal(git("add", "README.md").exitCode, 0);
  assert.equal(git("commit", "-q", "-m", "fixture").exitCode, 0, "git commit");
  const repoWorkspace = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-repo" });
  workspaces.push(repoWorkspace.workspace.workspace_id);
  const repoRow = page.locator(`.pane-item:has(.pane-select[title^="${repoWorkspace.root_pane.pane_id} —"])`);
  await repoRow.waitFor();
  await repoRow.hover();
  await repoRow.locator(".row-menu-toggle").click();
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
  const newWorktree = page.getByRole("dialog", { name: /^New worktree/ });
  await newWorktree.waitFor();
  // the branch and the name arrive filled in, as herdr's own form fills them, and the name follows the branch
  const suggested = await newWorktree.getByLabel(/^Branch/).inputValue();
  assert.match(suggested, /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), suggested.replace("/", "-"));
  await newWorktree.getByLabel(/^Branch/).fill("herdr-web-ui-test-feature");
  // the agent to start in the checkout is chosen here; the run takes a shell so nothing is launched
  const worktreeAgent = newWorktree.getByRole("combobox", { name: "Agent" });
  await worktreeAgent.click();
  await page.getByRole("option", { name: "Shell", exact: true }).click();
  assert.equal((await worktreeAgent.textContent())?.trim(), "Shell");
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), "herdr-web-ui-test-feature");
  const worktreeResponse = page.waitForResponse((response) => response.url().endsWith("/api/worktree/create"));
  await newWorktree.getByRole("button", { name: "Create worktree", exact: true }).click();
  const worktree = await (await worktreeResponse).json() as WorktreeOpened;
  worktreeWorkspaces.push(worktree.workspace_id);
  assert.equal(worktree.branch, "herdr-web-ui-test-feature");
  await newWorktree.waitFor({ state: "detached" });
  await until(async () => (await page.locator(`.pane-select[title^="${worktree.pane_id} —"]`).getAttribute("aria-current")) === "true", "the worktree's pane is selected");
  await repoRow.hover();
  await repoRow.locator(".row-menu-toggle").click();
  await page.getByRole("menuitem", { name: "Open worktree…", exact: true }).click();
  const openWorktree = page.getByRole("dialog", { name: /^Open worktree/ });
  await openWorktree.waitFor();
  const entry = openWorktree.locator(".worktree-row", { hasText: "herdr-web-ui-test-feature" });
  await entry.waitFor();
  assert.equal(await entry.locator(".pill").count(), 1, "the open checkout is marked as open");
  await page.keyboard.press("Escape");
  await openWorktree.waitFor({ state: "detached" });
  console.log("PASS a worktree opens from the row menu as a grouped workspace, and Open worktree… knows it");

  // In the By workspace view the worktree's row sits under its repository's, as herdr packs them.
  // Its menu deletes the checkout: a dirty one is refused in git's words first, then deleted anyway.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('.segmented[aria-label="Sidebar grouping"]').getByRole("button", { name: "By workspace", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  const childRow = page.locator(`.worktree-children .pane-item:has(.pane-select[title^="${worktree.pane_id} —"])`);
  await childRow.waitFor();
  assert.equal(await page.locator(".worktree-children").count(), 1, "one group of worktrees, under the repository's row");
  // reorder is group-aware: the repository's row moves up past the group before it, as one, and
  // its lone worktree has no sibling to move among, so nothing is sent for it
  const moves: number[] = [];
  await page.route("**/api/workspace/move", async (route) => { moves.push(route.request().postDataJSON().insert_index as number); await route.continue(); });
  const orderBefore = (await herdrRpc<{ snapshot: { workspaces: { workspace_id: string }[] } }>("session.snapshot", {})).snapshot.workspaces.map((workspace) => workspace.workspace_id);
  await repoRow.locator(".sidebar-drag-handle").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await until(() => moves.length === 1, "the repository's row moved up as a group");
  assert.equal(moves[0], orderBefore.indexOf(repoWorkspace.workspace.workspace_id) - 1, "it lands before the group above it");
  await childRow.locator(".sidebar-drag-handle").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(400);
  assert.equal(moves.length, 1, "a lone worktree has nowhere to move");
  await page.unroute("**/api/workspace/move");
  writeFileSync(join(worktree.path, "unsaved.txt"), "dirty\n");
  await childRow.hover();
  await childRow.locator(".row-menu-toggle").click();
  const childMenu = page.getByRole("menu");
  await childMenu.waitFor();
  assert.deepEqual(await childMenu.getByRole("menuitem").allTextContents(), ["Rename workspace", "Rename pane", "New tab", "Close", "Delete worktree checkout…"], "a worktree row's menu");
  await childMenu.getByRole("menuitem", { name: "Delete worktree checkout…", exact: true }).click();
  const deleteConfirm = page.getByRole("alertdialog");
  await deleteConfirm.waitFor();
  await deleteConfirm.getByRole("button", { name: "Delete", exact: true }).click();
  await deleteConfirm.getByRole("button", { name: "Delete anyway", exact: true }).waitFor();
  assert.equal(await deleteConfirm.locator(".confirm-error").count(), 1, "git's refusal shows in the confirm");
  await deleteConfirm.getByRole("button", { name: "Delete anyway", exact: true }).click();
  await deleteConfirm.waitFor({ state: "detached" });
  await childRow.waitFor({ state: "detached" });
  assert.equal(existsSync(worktree.path), false, "the checkout is gone");
  worktreeWorkspaces.splice(worktreeWorkspaces.indexOf(worktree.workspace_id), 1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('.segmented[aria-label="Sidebar grouping"]').getByRole("button", { name: "By folder", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS a worktree row sits under its repository's row, and its menu deletes the checkout, asking twice for a dirty one");

  // A second tab from the row's ⋯ menu: the dialog is New tab, with the workspace's folder shown
  // and not asked for; the new pane opens, the workspace stays one row, and a strip over the pane
  // lists both tabs from then on. The header's New tab opens the same dialog on a desktop.
  // The new pane's terminal takes the focus once it paints, which would close a menu opened before.
  await until(() => painted.has(created.pane_id), "created pane paint");
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the created workspace is selected again");
  await page.locator(".pane-item.is-selected .row-menu-toggle").click();
  await page.getByRole("menuitem", { name: "New tab", exact: true }).click();
  const tabDialog = page.getByRole("dialog", { name: /^New tab · herdr-web-ui-test-browser-created/ });
  await tabDialog.waitFor();
  assert.equal(await tabDialog.locator(".new-session-folder").textContent(), root, "the folder is the workspace's, shown");
  assert.equal(await tabDialog.getByRole("button", { name: "Browse", exact: true }).count(), 0, "the folder is not asked for");
  await tabDialog.getByLabel(/^Name/).fill("second");
  const tabResponse = page.waitForResponse((response) => response.url().endsWith("/api/tab/create"));
  await tabDialog.getByRole("button", { name: "Start", exact: true }).click();
  const createdTab = await (await tabResponse).json() as WorkspaceCreated;
  assert.equal(createdTab.workspace_id, created.workspace_id, "the tab joins the workspace");
  await tabDialog.waitFor({ state: "hidden" });
  await until(async () => (await page.locator(`.pane-select[title^="${createdTab.pane_id} —"]`).getAttribute("aria-current")) === "true", "the new tab's pane is selected, and the row shows it");
  assert.equal(await page.locator(`.pane-select[title^="${created.pane_id} —"]`).count(), 0, "the workspace stays one row");
  const strip = page.locator(".tab-strip");
  await strip.waitFor();
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["Tab 1", "second"]);
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "second");
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab opens its pane again");
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "Tab 1");
  // reopened right after a creation: its fields are live and Escape puts it away at once
  await page.locator(".new-tab-button").click();
  await tabDialog.waitFor();
  assert.equal(await tabDialog.getByRole("button", { name: "Start", exact: true }).isDisabled(), false, "a reopened dialog is not left pending");
  await page.keyboard.press("Escape");
  await tabDialog.waitFor({ state: "hidden" });
  // the PC's + is New workspace again, not a tab in the workspace the last dialog was for
  await page.getByRole("button", { name: /^New workspace on / }).click();
  await page.getByRole("dialog", { name: /^New workspace/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: /^New workspace/ }).waitFor({ state: "hidden" });
  console.log("PASS a second tab is made from the row's menu, listed in a strip over the pane, and opened from it");

  // A tab is renamed and closed from the strip, as herdr's prefix+shift+t and prefix+shift+x.
  const tabsInHerdr = async () => (await sessionSnapshot()).tabs.filter((tab) => tab.workspace_id === created.workspace_id).map((tab) => tab.label);
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).dblclick();
  const tabName = strip.getByLabel("Tab name", { exact: true });
  await tabName.waitFor();
  await tabName.fill("  first  ");
  await page.keyboard.press("Enter");
  await until(async () => (await tabsInHerdr()).join() === "first,second", "herdr has the tab's new name, trimmed");
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["first", "second"]);
  await until(async () => await strip.getByRole("tab", { name: "first", exact: true }).evaluate((tab) => tab === document.activeElement), "the renamed tab has the focus back");
  // F2 opens the field on the focused tab; Escape leaves the name alone, and so does an empty one
  await page.keyboard.press("F2");
  await tabName.fill("discarded");
  // an IME's committing Enter is the composition's: the field stays, and nothing is sent
  await tabName.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  assert.equal(await tabName.count(), 1, "an IME's Enter does not save the name");
  await page.keyboard.press("Escape");
  await tabName.waitFor({ state: "detached" });
  await page.keyboard.press("F2");
  await tabName.fill("   ");
  await page.keyboard.press("Enter");
  await tabName.waitFor({ state: "detached" });
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["first", "second"]);
  assert.equal((await tabsInHerdr()).join(), "first,second");
  // a right-click opens the tab's menu
  await strip.getByRole("tab", { name: "second", exact: true }).click({ button: "right" });
  const tabMenu = page.getByRole("menu", { name: "second", exact: true });
  await tabMenu.waitFor();
  assert.deepEqual(await tabMenu.getByRole("menuitem").allTextContents(), ["Rename tab", "Close tab"]);
  await tabMenu.getByRole("menuitem", { name: "Rename tab", exact: true }).click();
  await tabName.fill("build");
  await page.keyboard.press("Enter");
  await until(async () => (await tabsInHerdr()).join() === "first,build", "the menu's rename reaches herdr");
  // on a touch screen the open tab carries a chevron in place of the x: the same menu, as a sheet
  const tabPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tabPhonePage = await tabPhone.newPage();
  tabPhonePage.on("pageerror", (error) => errors.push(error.message));
  await tabPhonePage.goto(`${origin}/?pane=${encodeURIComponent(createdTab.pane_id)}`);
  const phoneStrip = tabPhonePage.locator(".tab-strip");
  await phoneStrip.getByRole("tab", { name: "build", exact: true, selected: true }).waitFor();
  assert.equal(await phoneStrip.locator(".tab-strip-close:visible").count(), 0, "no x under a finger");
  assert.equal(await phoneStrip.locator(".tab-strip-panes:visible").count(), 1, "only the open tab has the chevron");
  await phoneStrip.getByRole("button", { name: "Actions for build", exact: true }).tap();
  const tabSheet = tabPhonePage.getByRole("dialog", { name: "build", exact: true });
  await tabSheet.waitFor();
  assert.deepEqual(await tabSheet.locator(".row-sheet-item").allTextContents(), ["Rename tab", "Close tab"]);
  await tabSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
  await tabSheet.waitFor({ state: "detached" });
  await tabPhone.close();
  // a tab whose agent is at work asks before it closes; a no leaves it
  await herdrRpc("pane.report_agent", { pane_id: createdTab.pane_id, source: "manual", agent: "codex", state: "working" });
  await strip.locator('.tab-strip-dot[data-status="working"]').waitFor();
  await strip.getByRole("tab", { name: "build", exact: true }).hover();
  await strip.getByRole("button", { name: "Close tab build", exact: true }).click();
  const closeTabDialog = page.getByRole("alertdialog", { name: "Close tab build?", exact: true });
  await closeTabDialog.waitFor();
  await closeTabDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await closeTabDialog.waitFor({ state: "detached" });
  assert.equal((await tabsInHerdr()).join(), "first,build");
  // a tab whose agent has finished closes at once from its x, and the tab beside it opens
  await herdrRpc("pane.report_agent", { pane_id: createdTab.pane_id, source: "manual", agent: "codex", state: "idle" });
  await strip.locator('.tab-strip-dot[data-status="working"]').waitFor({ state: "detached" });
  await herdrRpc("tab.create", { workspace_id: created.workspace_id, label: "third", focus: false });
  const third = strip.getByRole("tab", { name: "third", exact: true });
  await third.click();
  await until(async () => (await third.getAttribute("aria-selected")) === "true", "the third tab is open");
  // a held Delete is one press: its repeats close nothing
  await third.dispatchEvent("keydown", { key: "Delete", repeat: true, bubbles: true });
  await page.waitForTimeout(300);
  assert.equal((await tabsInHerdr()).join(), "first,build,third");
  await strip.getByRole("button", { name: "Close tab third", exact: true }).click();
  await until(async () => (await tabsInHerdr()).join() === "first,build", "the x closed the tab");
  await until(async () => (await page.locator(`.pane-select[title^="${createdTab.pane_id} —"]`).getAttribute("aria-current")) === "true", "the tab beside the closed one is open");
  // Delete on a focused tab that is not the open one closes it; the strip goes with it (one
  // pane left), the open pane stays, and the focus goes where a closed row's goes
  await strip.getByRole("tab", { name: "first", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab is open");
  await strip.getByRole("tab", { name: "first", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await until(async () => await strip.getByRole("tab", { name: "build", exact: true }).evaluate((tab) => tab === document.activeElement), "the arrow moved the focus to the other tab");
  await page.keyboard.press("Delete");
  await strip.waitFor({ state: "detached" });
  assert.equal((await tabsInHerdr()).join(), "first", "herdr closed the tab and kept the other");
  assert.equal(await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current"), "true", "the open pane stays");
  await until(async () => await page.evaluate(() => document.activeElement?.matches(".app-header .drawer-toggle, .app-header .sidebar-toggle") === true), "the focus is not left on the page");
  console.log("PASS a tab is renamed by a double-click, F2 and its menu, and closed from its x and Delete, asking first while its agent works");

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

  // Claude's grey suggestion in its empty input box stands in the composer. A send drops it,
  // and the same text suggested again comes back; a pane switch never shows the last pane's.
  const paintSuggestion = async (pane: string, suggestion: string): Promise<void> => {
    await herdrRpc("pane.send_text", {
      pane_id: pane,
      text: `printf '\\033[2J\\033[H%s\\n\\342\\235\\257 \\033[2m%s\\033[0m\\n%s\\n' "$(printf '\\342\\224\\200%.0s' $(seq 40))" '${suggestion}' "$(printf '\\342\\224\\200%.0s' $(seq 40))"; read -r qa_suggest; clear`,
    });
    await herdrRpc("pane.send_keys", { pane_id: pane, keys: ["Enter"] });
    await until(async () => {
      const result = await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: pane, source: "visible", format: "text" });
      return result.read.text.includes(`❯ ${suggestion}`);
    }, "suggestion painted");
  };
  await selectPane(paneA);
  await composer.fill("");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  await paintSuggestion(paneA, "run the tests");
  await until(async () => await composer.getAttribute("placeholder") === "run the tests", "suggestion as placeholder");
  await composer.focus();
  await page.keyboard.press("Tab");
  assert.equal(await composer.inputValue(), "run the tests", "Tab takes the suggestion");
  // a prompt read made before the send answers after it: its suggestion was for the turn before
  let readBeforeSend = false;
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`, async (route) => {
    const response = await route.fetch();
    readBeforeSend = true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await until(async () => readBeforeSend, "a prompt read in flight");
  await composer.press("Enter");
  await until(async () => await composer.getAttribute("placeholder") !== "run the tests", "a send drops the suggestion");
  await until(async () => await composer.inputValue() === "", "the sent box clears");
  for (let check = 0; check < 16; check++) {
    assert.notEqual(await composer.getAttribute("placeholder"), "run the tests", "a read from before the send does not bring the suggestion back");
    await page.waitForTimeout(150);
  }
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`);
  // the same text suggested again after the turn shows again
  await paintSuggestion(paneA, "run the tests");
  await until(async () => await composer.getAttribute("placeholder") === "run the tests", "the same suggestion again");
  // pane B answers its first prompt read late: meanwhile it must not show pane A's suggestion
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "idle" });
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await selectPane(paneB);
  for (let check = 0; check < 8; check++) {
    assert.notEqual(await composer.getAttribute("placeholder"), "run the tests", "another pane's suggestion never shows");
    await page.waitForTimeout(150);
  }
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`);
  await herdrRpc("pane.send_keys", { pane_id: paneA, keys: ["Enter"] });
  console.log("PASS Claude's suggestion fills the composer with Tab, returns after a send, and stays with its pane");
  await checkStatusUsage(browser!, origin, { claude: paneA, codex: paneB },
    (pane, agent) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: "idle" }));

  // "Send now" on a queued message is a send too: the suggestion goes at once, not at the next read
  await selectPane(paneA);
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "working" });
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await composer.fill("# queued before the suggestion");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  // idle after working reads as done: either way the queue waits for its Send now
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await paintSuggestion(paneA, "check the diff");
  await until(async () => await composer.getAttribute("placeholder") === "check the diff", "suggestion beside a queued message");
  // every read after the send answers late: only the send itself can drop the suggestion in time
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue().catch(() => {});
  });
  const sentAt = Date.now();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await until(async () => await composer.getAttribute("placeholder") !== "check the diff", "Send now drops the suggestion");
  assert.ok(Date.now() - sentAt < 2500, "the suggestion goes with the Send now, not with a later read");
  await page.locator(".composer-queue-text").waitFor({ state: "hidden" });
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`);
  console.log("PASS Send now on a queued message drops Claude's suggestion");

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
  // a phone's status line holds the agent and its state: no report action, and no keyboard button while typing
  await mobilePage.evaluate(() => document.documentElement.setAttribute("data-keyboard", ""));
  assert.equal(await mobilePage.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "no report action on a phone");
  assert.equal(await mobilePage.getByRole("button", { name: "Hide keyboard", exact: true }).count(), 0, "no keyboard button on a phone");
  await mobilePage.evaluate(() => document.documentElement.removeAttribute("data-keyboard"));
  assert.deepEqual(errors, []);
  console.log("PASS mobile composer with unavailable storage and no horizontal overflow");

  // a phone reads a pane before it answers: a pane picked from the drawer raises no keyboard,
  // and a tap on the message box does
  const typing = (target: typeof mobilePage) => target.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false);
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).blur();
  await mobilePage.locator('button[aria-controls="workspace-drawer"]').click();
  await mobilePage.locator(`.pane-select[title^="${paneA} —"]`).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await mobilePage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await mobilePage.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(await typing(mobilePage), false, "a pane picked on a phone does not take the keyboard");
  await mobilePage.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await mobilePage.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(await typing(mobilePage), false, "nor does switching its lens");
  await mobilePage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).tap();
  await until(() => typing(mobilePage), "a tap on the message box takes the keyboard");
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).blur();
  await mobilePage.locator('button[aria-controls="workspace-drawer"]').click();
  await mobilePage.locator(`.pane-select[title^="${paneB} —"]`).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  console.log("PASS a pane picked on a phone waits for a tap before raising the keyboard");

  // Claude's suggestion on a phone is the placeholder only, until Settings turns its chip on
  const promptRoute = `**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`;
  const suggest = { json: { prompt: null, suggestion: "run the tests" } };
  const mobileComposer = mobilePage.getByRole("textbox", { name: "Message", exact: true });
  await mobilePage.route(promptRoute, (route) => route.fulfill(suggest));
  await mobileComposer.fill("");
  await until(async () => await mobileComposer.getAttribute("placeholder") === "run the tests", "a phone shows the suggestion as the placeholder");
  assert.equal(await mobilePage.getByTitle("Use the suggestion", { exact: true }).count(), 0, "no suggestion chip until Settings turns it on");
  await mobilePage.unroute(promptRoute);
  const chipPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await chipPhone.addInitScript(() => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showSuggestionChip: true })); });
  const chipPage = await chipPhone.newPage();
  chipPage.on("pageerror", (error) => errors.push(error.message));
  await chipPage.route(promptRoute, (route) => route.fulfill(suggest));
  await chipPage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await chipPage.locator(".conn-live").waitFor();
  await chipPage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await chipPage.getByTitle("Use the suggestion", { exact: true }).click();
  assert.equal(await chipPage.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "run the tests", "the chip puts the suggestion in the box");
  await chipPhone.close();
  assert.deepEqual(errors, []);
  console.log("PASS a phone offers Claude's suggestion as a chip only once Settings turns it on");

  await checkTerminalInput(browser, origin, paneA, paneB);

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
  await line.dispatchEvent("compositionstart", { data: "" });
  const beforeComposeSend = touchSent.length;
  await touchPage.getByRole("button", { name: "Send to the terminal", exact: true }).click();
  await touchPage.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(touchSent.length, beforeComposeSend, "button cannot submit an unfinished composition");
  await line.dispatchEvent("compositionend", { data: "한글" });
  await line.fill("");
  // an empty line's button is Enter alone
  const enters = touchSent.length;
  await touchPage.getByRole("button", { name: "Press Enter in the terminal", exact: true }).click();
  await until(() => touchSent.length > enters && touchSent.at(-1)?.type === "input" && touchSent.at(-1)?.text === "\r", "enter from the empty line");
  await line.fill("unsent 한글 😀");
  // typing straight into the grid is one tap away, and gives the keyboard back to it
  await touchPage.getByRole("button", { name: "Type straight into the terminal", exact: true }).click();
  assert.equal(await touchPage.locator(".terminal-input").count(), 0);
  assert.equal(await touchPage.locator(".xterm-helper-textarea").getAttribute("inputmode"), null);
  await touchPage.getByRole("button", { name: "Type straight into the terminal", exact: true }).click();
  await line.waitFor();
  assert.equal(await line.inputValue(), "unsent 한글 😀", "mode switches preserve the unsent line");
  await touchPage.reload();
  await line.waitFor();
  assert.equal(await line.inputValue(), "unsent 한글 😀", "reload preserves the unsent line");
  await line.fill("");
  assert.equal(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await touchPage.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-input-mobile.png") });
  }
  await touch.close();
  console.log("PASS touch terminal input line sends whole lines, Enter alone, and yields to direct typing");

  // A closed pane and an obsolete saved pane both yield to a live pane. Local access
  // is automatic, so it must not offer a sign-out action that cannot lock the app.
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  // closed from the row's ⋯ menu; its last pane takes the workspace with it, so a confirm asks first
  await page.locator(".pane-item.is-selected .row-menu-toggle").click();
  const rowMenu = page.getByRole("menu");
  await rowMenu.waitFor();
  // Escape puts the menu away and the focus back on its button; Enter there opens it again
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("row-menu-toggle") ?? false), true, "Escape returns focus to the row's ⋯");
  await page.keyboard.press("Enter");
  await rowMenu.getByRole("menuitem", { name: "Close", exact: true }).click();
  const confirmClose = page.getByRole("alertdialog");
  await confirmClose.waitFor();
  await until(async () => await page.evaluate(() => document.activeElement?.textContent === "Cancel"), "the confirm starts on Cancel");
  // a no gives the focus back to the row's ⋯; Tab stays inside the confirm
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Close", "Tab moves to the confirm's action");
  await page.keyboard.press("Escape");
  await confirmClose.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("row-menu-toggle") ?? false), true, "cancelling the confirm returns focus to the row's ⋯");
  await page.keyboard.press("Enter");
  await rowMenu.getByRole("menuitem", { name: "Close", exact: true }).click();
  await confirmClose.waitFor();
  await confirmClose.getByRole("button", { name: "Close", exact: true }).click();
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
  // a worktree checkout the run made goes with it: herdr removes the checkout, then its workspace.
  // The roster says what was made, so a create whose answer never arrived is removed too.
  if (repo) {
    const repoRoot = realpathSync(repo);
    const snapshot = await sessionSnapshot().catch(() => null);
    for (const workspace of snapshot?.workspaces ?? []) {
      if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot && !worktreeWorkspaces.includes(workspace.workspace_id)) worktreeWorkspaces.push(workspace.workspace_id);
    }
  }
  for (const id of worktreeWorkspaces) {
    await herdrRpc("worktree.remove", { workspace_id: id, force: true }).catch(() => undefined);
    await workspaceClose(id).catch(() => undefined);
  }
  // herdr keeps the repository's folder under its worktree directory once the checkout is gone: only an empty one is ours to drop
  if (repo) try { rmdirSync(join(homedir(), ".herdr", "worktrees", basename(repo))); } catch { /* not there, or not empty: not ours */ }
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
