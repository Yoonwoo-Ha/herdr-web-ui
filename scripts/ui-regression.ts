/** Real-browser regressions against owned herdr panes. Run after `bun run build`. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { copyFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { SessionSnapshot, WorkspaceCreated, WorktreeOpened } from "../shared/protocol.ts";
import type { Machine } from "../shared/machines.ts";
import { alertsOffMarked, alertsState, runMoreItem } from "./header-more.ts";
import { checkPushSettings } from "./push-settings-regression.ts";
import { checkWakeLock } from "./wake-lock-regression.ts";
import { checkSecretInput } from "./secret-input-regression.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkUsageMeters } from "./usage-regression.ts";
import { checkNotificationStartup } from "./notification-startup-regression.ts";
import { checkNotificationView } from "./notification-view-regression.ts";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { checkMobileTabs } from "./mobile-tabs-regression.ts";
import { checkTerminalFileInput } from "./terminal-file-input-regression.ts";
import { checkTerminalInput } from "./terminal-input-regression.ts";
import { checkSafariIme } from "./terminal-safari-ime-regression.ts";
import { checkHeldDraftPaneSwitch } from "./terminal-draft-regression.ts";
import { checkDefaultView } from "./default-view-regression.ts";
import { checkComposerReconnect } from "./composer-reconnect-regression.ts";
import { checkDroplet } from "./droplet-regression.ts";
import { checkSplitView } from "./split-view-regression.ts";
import { checkTakeOver } from "./take-over-regression.ts";
import { checkAlertSound } from "./alert-sound-regression.ts";
import { checkBackgroundTabKeepsTerminalSize, checkChatKeepsTerminalSize, checkPaneSwitchKeepsTerminalSize } from "./chat-size-regression.ts";
import { checkCommandBackspace } from "./terminal-command-backspace-regression.ts";
import { checkCtrlEnter } from "./terminal-ctrl-enter-regression.ts";
import { checkCommandArrows } from "./terminal-command-arrows-regression.ts";
import { checkFolderFilter } from "./folder-filter-regression.ts";
import { checkUpdateNotice } from "./update-notice-regression.ts";
import { UsageService } from "../server/usage.ts";
import { openSettingsPage } from "./settings-page.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { browserEvidencePage, browserEvidenceTracing, startBrowserEvidence } from "./browser-evidence.ts";
import type { BrowserEvidenceSession } from "./browser-evidence.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-web-ui-browser-")));
const workspaces: string[] = [];
const worktreeWorkspaces: string[] = [];
// the repository the worktree step makes, for the cleanup to find what the step made
let repo: string | null = null;
const releases: Array<() => void> = [];
const errors: string[] = [];
/** One entry per page that loaded the app through the real server, and so saw the real policy. */
const csp: CspWatch[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const evidenceSessions: BrowserEvidenceSession[] = [];
const evidenceDirectory = process.env.CHECK_BROWSER_EVIDENCE_DIR;
const evidenceTrace = process.env.CHECK_BROWSER_EVIDENCE_TRACE === "1";
async function watchBrowserEvidence(context: BrowserContext, page: Page, scenario: string): Promise<BrowserEvidenceSession | undefined> {
  if (!evidenceDirectory) return undefined;
  const evidence = await startBrowserEvidence({
    page: browserEvidencePage(page),
    tracing: browserEvidenceTracing(context),
    directory: evidenceDirectory,
    script: "ui-regression",
    scenario,
    trace: evidenceTrace,
  });
  evidenceSessions.push(evidence);
  return evidence;
}
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
    // English whatever the machine's own languages are (macOS Chrome takes them from the system)
    headless: true, args: ["--no-sandbox", "--accept-lang=en-US"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((ids) => {
    // only the first load: a reload must keep what Settings stored, such as the language
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
  }, panes);

  const page = await context.newPage();
  const pageEvidence = evidenceDirectory ? await watchBrowserEvidence(context, page, "main-app") : undefined;
  const workspaceGroup = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"]`);
  const workspaceHeader = (workspaceId: string) => workspaceGroup(workspaceId).locator(":scope > .workspace-header");
  const agentRow = (paneId: string) => page.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${paneId}"]`);
  // the header under test is the app's own (server/static.ts), so this is where a broken
  // directive shows up: every page below loads through this same server
  csp.push(await watchCsp(page));
  let holdSubmitResult = false;
  let releaseSubmitResult: (() => void) | null = null;
  // a connection's first frame held back: what the page does between a reconnect and its snapshot
  let holdSnapshot = false;
  let releaseSnapshot: (() => void) | null = null;
  const routed: Array<{ close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    routed.push(socket);
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (holdSnapshot && message.type === "snapshot") {
        holdSnapshot = false;
        const release = () => { socket.send(raw); releaseSnapshot = null; };
        releaseSnapshot = release;
        releases.push(release);
      } else if (holdSubmitResult && message.type === "submit-result") {
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
  const inputs: Array<{ type: "input" | "submit"; pane_id: string; text: string; delivery?: "immediate" | "queue" }> = [];
  const pendingActions: Array<{ pane_id: string; pending_id: string; action: string }> = [];
  // keyed by pane, with the connection that said so: an earlier connection's input-ready says nothing about the current one
  const inputStates = new Map<string, { ready: boolean; at: number; socket: import("playwright-core").WebSocket }>();
  const pendingReady = (pane: string) => until(() => {
    const state = inputStates.get(pane);
    return state?.ready === true && state.socket === sockets.at(-1) && !state.socket.isClosed() && Date.now() - state.at >= 500;
  }, `stable pending attachment of ${pane}`);
  page.on("websocket", (socket) => {
    sockets.push(socket);
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "pty-data") painted.add(message.pane_id);
      if (message.type === "input-ready") inputStates.set(message.pane_id, { ready: message.ready !== false, at: Date.now(), socket });
    });
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      // composer messages go out as "submit" on servers that list it (#15), keystrokes as "input"
      if (message.type === "input" || message.type === "submit") inputs.push(message);
      if (message.type === "pending-action") pendingActions.push(message);
      if (message.type === "attach" || message.type === "detach") inputStates.set(message.pane_id, { ready: false, at: Date.now(), socket });
    });
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
  await page.locator(".conn-live").waitFor();
  await until(() => painted.has(paneA), "owned pane paint");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();
  await page.locator(".composer .voice-mic").waitFor();
  console.log("PASS a desktop's chat offers the mic before Settings is asked");
  assert.equal(await workspaceHeader(workspaces[0]!).locator(".workspace-name").textContent(), "herdr-web-ui-test-browser-a",
    "Spaces names the workspace rather than its current pane");
  assert.equal(await workspaceGroup(workspaces[0]!).locator(".pane-select").count(), 1, "a workspace has one representative selector");
  assert.equal(await page.locator(".workspace-contents, .sidebar-tab-heading, .sidebar-pane-item").count(), 0,
    "Spaces has no tab or pane tree");
  assert.equal(await agentRow(paneA).count(), 0, "a plain shell is absent from Agents");
  assert.equal(await agentRow(paneB).count(), 0, "another plain shell is absent from Agents");

  // The search owns arrow/Enter navigation. Tab still reaches real buttons: Enter on Close
  // must close without selecting the highlighted result, and Enter on a row runs that row.
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const paletteSearch = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  const selectedPane = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")?.pane_id as string | undefined);
  const openPalette = async (): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await palette.waitFor();
    await until(async () => await paletteSearch.evaluate((input) => document.activeElement === input), "palette search takes focus");
  };
  await openPalette();
  await paletteSearch.fill("herdr-web-ui-test-browser-b");
  await until(async () => await palette.locator(".palette-pane").count() === 1, "the other pane is the palette's only result");
  await page.keyboard.press("Tab");
  assert.equal(await palette.getByRole("button", { name: "Close command palette", exact: true }).evaluate((button) => document.activeElement === button), true,
    "Tab reaches the close button from search");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "hidden" });
  assert.equal(await selectedPane(), paneA, "Enter on Close leaves the pane selection alone");

  // A reopened palette starts from an empty search in its first render, the DOM its opening commit
  // leaves (sampled by the observer before any later task): a render of the last search's results lets
  // a Tab that lands before the next one focus a row at an index the full list then gives to another (#608).
  await page.evaluate(() => {
    const frames: string[] = [];
    (window as unknown as { paletteFirstFrame: string[] }).paletteFirstFrame = frames;
    new MutationObserver((_, observer) => {
      const search = document.querySelector<HTMLInputElement>(".command-palette input[type=search]");
      if (!search) return;
      frames.push(search.value);
      observer.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  await openPalette();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { paletteFirstFrame: string[] }).paletteFirstFrame), [""],
    "a reopened palette's first render shows none of the last search's results");
  const otherPalettePane = palette.locator(".palette-pane").filter({ hasText: "herdr-web-ui-test-browser-b" });
  // Walk the actual tab order instead of clicking: pointer hover must not pick the row for us.
  for (const deadline = Date.now() + 5_000; ;) {
    await page.keyboard.press("Tab");
    if (await otherPalettePane.evaluate((button) => document.activeElement === button)) break;
    assert.ok(Date.now() < deadline, "Tab reaches the other pane's option");
  }
  // bounded: in #608's race the focused row never became the highlighted one, so this still fails there
  await until(async () => await otherPalettePane.evaluate((button) =>
    document.activeElement === button && button.getAttribute("aria-selected") === "true"), "the focused option is highlighted");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "hidden" });
  await until(async () => await selectedPane() === paneB, "Enter on the focused option selects that pane");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => await selectedPane() === paneA, "return to the first pane after palette selection");

  await openPalette();
  await paletteSearch.fill("herdr-web-ui-test-browser-b");
  await until(async () => await palette.locator(".palette-pane").count() === 1, "IME check has a matching result to avoid activating");
  const paletteComposition = await paletteSearch.evaluate((input) => [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "ArrowUp", isComposing: true },
    { key: "ArrowDown", isComposing: true },
    { key: "Escape", isComposing: true },
    { key: "Escape", keyCode: 229 },
  ].map((init) => input.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))));
  assert.deepEqual(paletteComposition, [true, true, true, true, true, true], "IME candidate, commit and cancel keys keep their default action");
  assert.equal(await palette.isVisible(), true, "IME Enter and Escape leave the palette open");
  assert.equal(await selectedPane(), paneA, "IME Enter never activates its matching pane");
  assert.equal(await paletteSearch.inputValue(), "herdr-web-ui-test-browser-b", "IME cancellation leaves the query alone");
  await paletteSearch.press("Escape");
  await palette.waitFor({ state: "hidden" });

  // Short desktop and phone lists both overflow. Wrapping up from the first result and down
  // from the last keeps the active option visible while typing focus stays in search.
  const paletteViewport = page.viewportSize()!;
  for (const viewport of [{ width: 1280, height: 400 }, { width: 390, height: 600 }]) {
    await page.setViewportSize(viewport);
    await openPalette();
    await page.mouse.move(0, 0);
    assert.equal(await palette.locator(".palette-results").evaluate((list) => list.scrollHeight > list.clientHeight), true,
      "the short palette has a scrollable list");
    const optionCount = await palette.getByRole("option").count();
    const visibleActiveOption = () => palette.locator(".palette-results").evaluate((list) => {
      const option = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!option) return false;
      const row = option.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
    });
    await paletteSearch.press("ArrowUp");
    await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === `palette-item-${optionCount - 1}` && await visibleActiveOption(),
      "ArrowUp wraps to the last visible palette option");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `palette-arrow-${viewport.width <= 640 ? "mobile" : "desktop"}.png`) });
    }
    await paletteSearch.press("ArrowDown");
    await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === "palette-item-0" && await visibleActiveOption(),
      "ArrowDown wraps back to the first visible palette option");
    assert.equal(await paletteSearch.evaluate((input) => document.activeElement === input), true, "arrow navigation keeps typing focus in search");
    await paletteSearch.press("Escape");
    await palette.waitFor({ state: "hidden" });
  }
  // A pointer resting over the list keeps still while the arrow scrolls rows under it: the
  // browser's hover update after the scroll must not take the keyboard selection, and a real
  // pointer move still does.
  await page.setViewportSize({ width: 1280, height: 400 });
  await openPalette();
  const restingOptionCount = await palette.getByRole("option").count();
  const firstOption = (await palette.locator("#palette-item-0").boundingBox())!;
  await page.mouse.move(firstOption.x + firstOption.width / 2, firstOption.y + firstOption.height / 2);
  await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === "palette-item-0", "the resting pointer is over the first option");
  await palette.locator(".palette-results").evaluate((list) => {
    const hovered: string[] = [];
    (window as unknown as { paletteHovered: string[] }).paletteHovered = hovered;
    list.addEventListener("mouseover", (event) => hovered.push((event.target as HTMLElement).closest("[role=option]")?.id ?? ""));
  });
  await paletteSearch.press("ArrowUp");
  await until(async () => await page.evaluate(() => (window as unknown as { paletteHovered: string[] }).paletteHovered.some((id) => id !== "" && id !== "palette-item-0")),
    "the scroll moves another option under the resting pointer");
  assert.equal(await paletteSearch.getAttribute("aria-activedescendant"), `palette-item-${restingOptionCount - 1}`,
    "a scroll under a resting pointer leaves the arrow's selection alone");
  const hoveredId = await page.evaluate(() => (window as unknown as { paletteHovered: string[] }).paletteHovered.findLast((id) => id !== "")!);
  const hoveredBox = (await palette.locator(`#${hoveredId}`).boundingBox())!;
  await page.mouse.move(hoveredBox.x + hoveredBox.width / 2 + 4, hoveredBox.y + hoveredBox.height / 2);
  await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === hoveredId, "a real pointer move selects the option under it");
  await paletteSearch.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await page.mouse.move(0, 0);
  await page.setViewportSize(paletteViewport);
  console.log("PASS palette buttons keep native Enter, IME keeps its keys, and arrow selection stays visible on short desktop and phone lists");

  // Hold a real machines response, then deliver a newer status through herdr/SSE.
  const badge = page.locator(".pane-item.is-selected .badge");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "blocked" });
  await until(async () => await badge.getAttribute("data-status") === "blocked", "blocked baseline");
  await agentRow(paneA).locator('.badge[data-status="blocked"]').waitFor();
  assert.equal(await agentRow(paneA).locator('.agent-select[aria-current="true"]').count(), 1,
    "Agents independently marks its selected pane");
  assert.equal(await agentRow(paneA).locator('.sidebar-status[role="status"]').count(), 1,
    "Agents uses a compact accessible status");
  assert.ok((await agentRow(paneA).locator(".agent-title").textContent())?.trim(), "an agent has a task title");
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
  await agentRow(paneA).locator('.badge[data-status="working"]').waitFor();
  releasePoll();
  await until(() => pollFinished, "stale machines response released");
  await page.waitForTimeout(300);
  assert.equal(await badge.getAttribute("data-status"), "working", "stale poll must not revert RUN to INPUT");
  assert.equal(await agentRow(paneA).locator(".badge").getAttribute("data-status"), "working",
    "a stale poll must not revert the separate Agents list either");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "pane-status-poll.png") });
  }
  await page.unroute("**/api/machines");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  const settledAgentStatus = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneA)?.agent_status;
  assert.ok(settledAgentStatus === "idle" || settledAgentStatus === "done", "herdr settles the completed turn");
  await agentRow(paneA).locator(`.badge[data-status="${settledAgentStatus}"]`).waitFor();
  console.log("PASS delayed machines poll preserves newer streamed pane status");

  // Agents is global to the sidebar, so collapsing a PC's Spaces does not hide
  // its reported agents or prevent explicit pane selection from that list.
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
  await agentRow(paneB).waitFor();
  const machineToggle = page.locator(".machine-group .machine-toggle");
  // the PC's fold is the caret beside its +
  assert.equal(await page.locator(".machine-group .machine-toggle + .machine-new").count(), 1);
  await machineToggle.click();
  await workspaceGroup(workspaces[0]!).waitFor({ state: "detached" });
  assert.equal(await agentRow(paneA).isVisible(), true, "PC folding leaves Agents visible");
  await agentRow(paneB).locator(".agent-select").click();
  await agentRow(paneB).locator('.agent-select[aria-current="true"]').waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")),
    { machine_id: "local", pane_id: paneB }, "Agent selection retains its machine and pane target");
  assert.equal(await machineToggle.getAttribute("aria-expanded"), "false", "Agent selection preserves the user's PC fold");
  painted.delete(paneA);
  await agentRow(paneA).locator(".agent-select").click();
  await agentRow(paneA).locator('.agent-select[aria-current="true"]').waitFor();
  await until(() => painted.has(paneA), "returning from Agents paints the current pane");
  await machineToggle.click();
  await workspaceHeader(workspaces[0]!).locator('.workspace-select[aria-current="true"]').waitFor();

  // Reuse the real API roster as an offline cache in an isolated context. Its
  // native disabled buttons must leave selection unchanged when clicked.
  const cachedRoster = await (await context.request.get(`${origin}/api/machines`)).json() as { machines: Machine[] };
  const offlineMachines = cachedRoster.machines.map((machine) => ({ ...machine, state: "disconnected" as const }));
  const offlineContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let offlineEvidence: BrowserEvidenceSession | undefined;
  try {
    await offlineContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false })));
    await offlineContext.route("**/api/machines", (route) => route.fulfill({ json: { machines: offlineMachines } }));
    await offlineContext.route("**/api/machines/events", (route) => route.fulfill({
      contentType: "text/event-stream", body: `retry: 60000\ndata: ${JSON.stringify({ type: "machines", machines: offlineMachines })}\n\n`,
    }));
    await offlineContext.routeWebSocket(/\/ws(?:\?|$)/, (socket) => socket.close({ code: 1000, reason: "Offline cached roster" }));
    const offlinePage = await offlineContext.newPage();
    offlineEvidence = evidenceDirectory ? await watchBrowserEvidence(offlineContext, offlinePage, "offline-cached-roster") : undefined;
    await offlinePage.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
    const offlineAgent = offlinePage.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${paneB}"] .agent-select`);
    await offlineAgent.waitFor();
    assert.equal(await offlineAgent.isDisabled(), true, "a cached offline agent cannot select its pane");
    const selectionBefore = await offlinePage.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
    await offlineAgent.dispatchEvent("click");
    assert.equal(await offlinePage.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selectionBefore,
      "offline Agent clicks leave the current selection unchanged");
  } catch (error) {
    await offlineEvidence?.captureFailure(error);
    throw error;
  } finally {
    if (offlineEvidence) await offlineEvidence.finish();
    await offlineContext.close();
  }
  console.log("PASS Agents excludes shells, survives PC folds, selects its machine target and disables offline rows");

  // a turn that ended on work still running in the background reads BG, not DONE: drawn in the sidebar, and read in the composer
  let backgroundPeer: "working" | "done" | "blocked" | "idle" | null = null;
  await page.route("**/api/machines", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { machines: { snapshot?: SessionSnapshot }[] };
    for (const machine of body.machines) {
      const pane = machine.snapshot?.panes.find((pane) => pane.pane_id === paneA);
      if (!pane || !machine.snapshot) continue;
      Object.assign(pane, { agent_status: "done", background_tasks: 1, background_wait: true });
      if (backgroundPeer) {
        const peer = { ...pane, pane_id: `${paneA}-background-peer`, agent_status: backgroundPeer, background_wait: undefined };
        machine.snapshot.panes.push(peer);
        const tab = machine.snapshot.tabs.find((tab) => tab.tab_id === pane.tab_id);
        if (tab) tab.agent_status = backgroundPeer === "blocked" ? "blocked" : "done";
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const waitingBadge = agentRow(paneA).locator(".badge[data-status=waiting]");
  await waitingBadge.waitFor();
  assert.equal((await waitingBadge.textContent())?.trim(), "BG");
  assert.equal(await waitingBadge.getAttribute("title"), "Agent waiting on background work");
  assert.equal(await waitingBadge.locator("svg").count(), 1, "BG draws the running arc, held still");
  await page.locator('.composer-status[data-status="waiting"] strong.visually-hidden', { hasText: "BG" }).waitFor();
  for (const peer of ["working", "done", "blocked", "idle"] as const) {
    backgroundPeer = peer;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const expected = peer === "idle" ? "waiting" : peer;
    await page.locator(`.tab-strip-tab[aria-selected="true"] .tab-strip-dot[data-status="${expected}"]`).waitFor();
  }
  backgroundPeer = null;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Appearance");
  const quietFinishes = page.getByRole("switch", { name: "Quiet opened finishes", exact: true });
  const quietBefore = await quietFinishes.getAttribute("aria-checked");
  if (quietBefore !== "true") await quietFinishes.click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await waitingBadge.waitFor();
  assert.equal((await waitingBadge.textContent())?.trim(), "BG", "Quiet opened finishes cannot hide a background hold");
  if (process.env.UI_EVIDENCE_DIR) {
    const viewport = page.viewportSize()!;
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.locator('.composer-status[data-status="waiting"]').waitFor();
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `background-wait-${width}-${theme}.png`), animations: "disabled" });
        if (width === 390) {
          const drawer = page.locator('button[aria-controls="workspace-drawer"]');
          await drawer.click();
          await waitingBadge.waitFor();
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `background-wait-${width}-${theme}-drawer.png`), animations: "disabled" });
          await drawer.click();
        }
      }
    }
    await page.setViewportSize(viewport);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, themeBefore);
  }
  if (quietBefore !== "true") {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Appearance");
    await page.getByRole("switch", { name: "Quiet opened finishes", exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  }
  await page.unroute("**/api/machines");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitingBadge.waitFor({ state: "detached" });
  console.log("PASS a pane whose turn ended on its background work reads BG in the sidebar and the composer, and its status again once it does not");
  // Use a real browser paste: keydown must not send Ctrl+V (0x16) to the agent,
  // where it can trigger image paste against the server's unrelated clipboard.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await checkTerminalFileInput(page, sockets[0]!);
  const terminalInput = page.locator(".xterm-helper-textarea");
  // Chrome on macOS pastes with ⌘V alone: its Ctrl+V pastes nothing, and must send nothing either
  const mac = process.platform === "darwin";
  if (mac) {
    await terminalInput.focus();
    const beforeCtrlV = inputs.length;
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(NO_SEND_WAIT_MS);
    assert.deepEqual(inputs.slice(beforeCtrlV), [], "Ctrl+V must never send the image-paste control key");
  }
  for (const [shortcut, text] of [
    [mac ? "Meta+v" : "Control+v", "# terminal paste 한글"],
    [mac ? "Meta+v" : "Control+v", "# first line\n# second line"],
    ...mac ? [] : [["Control+Shift+v", "# plain text paste"]],
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
  await checkCtrlEnter(browser, origin, paneA);
  await checkCommandArrows(browser, origin, paneA);
  // a pane shortcut switches panes and types nothing: xterm used to send ESC[1;6B / ESC[1;6A too
  const selectedTitle = () => page.locator(".pane-item.is-selected .pane-select").getAttribute("title");
  // A pane just picked shows the lens of the pane before it for a moment, and the message box
  // of that lens can take the focus back: the key waits until the terminal still has it two frames on.
  const focusTerminal = () => until(async () => {
    await terminalInput.focus();
    return page.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      resolve(document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)))));
  }, "the terminal holds the focus");
  for (const key of ["ControlOrMeta+Shift+ArrowDown", "ControlOrMeta+Shift+ArrowUp"]) {
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

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS settings shortcut and theme");

  // Add PC lives in Settings → Remote PCs, not in the sidebar; opening it closes Settings behind it
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: "Add PC", exact: true }).count(), 0, "the sidebar has no Add PC button");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Remote PCs");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Add PC", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Settings" }).count(), 0, "Add PC closes Settings");
  await page.getByRole("button", { name: "Close PC setup", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor({ state: "hidden" });
  // its trigger went with Settings: focus lands on the header's workspace-list toggle instead of nowhere
  await until(async () => await page.evaluate(() => document.activeElement?.matches(".sidebar-toggle, .drawer-toggle") ?? false), "focus returns to the workspace-list toggle after Add PC closes");
  console.log("PASS Add PC opens from Settings, and the sidebar has no top bar");

  // the sidebar's right edge resizes it: its own top row in the header follows, the width is
  // kept on this device, the arrows move it from the keyboard and a double-click forgets it
  const sidebarWidths = () => page.evaluate(() => ({
    sidebar: Math.round(document.querySelector(".sidebar")!.getBoundingClientRect().width),
    header: Math.round(document.querySelector(".header-side")!.getBoundingClientRect().width),
    stored: localStorage.getItem("herdr-web-ui:sidebar-width"),
  }));
  const defaultWidths = await sidebarWidths();
  assert.equal(defaultWidths.stored, null, "no sidebar width is stored before the edge is dragged");
  const resizer = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const edge = (await resizer.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 80, 400, { steps: 4 });
  await page.mouse.up();
  const dragged = await sidebarWidths();
  assert.equal(dragged.sidebar, defaultWidths.sidebar + 80, "the sidebar follows its dragged edge");
  assert.equal(dragged.header, dragged.sidebar, "the sidebar's top row in the header keeps the sidebar's width");
  assert.equal(dragged.stored, String(dragged.sidebar), "the dragged width is kept on this device");
  await resizer.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal((await sidebarWidths()).sidebar, dragged.sidebar - 16, "an arrow key moves the focused edge one step");
  assert.equal(await resizer.getAttribute("aria-valuenow"), String(dragged.sidebar - 16));
  // half the window is the limit the keys enforce, and the edge reports it as the window changes
  const wide = page.viewportSize()!;
  await page.setViewportSize({ width: 900, height: wide.height });
  await until(async () => await resizer.getAttribute("aria-valuemax") === "450", "the edge's upper limit follows the window");
  await page.setViewportSize(wide);
  await until(async () => await resizer.getAttribute("aria-valuemax") !== "450", "the limit returns with the window");
  await resizer.dblclick();
  assert.deepEqual(await sidebarWidths(), defaultWidths, "a double-click goes back to the default width and forgets the stored one");
  console.log("PASS the sidebar's edge drags, steps from the keyboard, remembers its width and resets on a double-click");

  // Sidebar rows: a workspace row says what its pane is doing over its place, on a taller row,
  // until Settings → Sidebar rows → One line gives the workspace its name back
  const twoLineHeight = await page.locator(".workspace-header").first().evaluate((row) => row.getBoundingClientRect().height);
  assert.ok(await page.locator(".workspace-copy.is-two-line").count() > 0, "rows are two lines until one is chosen");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const rowsSetting = page.locator('.settings-dialog .segmented[aria-label="Sidebar rows"]');
  await rowsSetting.getByRole("button", { name: "One line", exact: true }).click();
  await page.locator(".workspace-copy.is-two-line").first().waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").sidebarRows), "one");
  assert.ok(await page.locator(".workspace-header").first().evaluate((row) => row.getBoundingClientRect().height) < twoLineHeight, "a one-line row is shorter");
  await rowsSetting.getByRole("button", { name: "Two lines", exact: true }).click();
  await page.locator(".workspace-copy.is-two-line").first().waitFor();
  await rowsSetting.getByRole("button", { name: "One line", exact: true }).click();
  await page.locator(".workspace-copy.is-two-line").first().waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS sidebar rows switch between one line and two");

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
    // The app takes the change in a task it posts during the event. A hide and a show sent one
    // after the other both land before that task, and are one render in which nothing changed:
    // a task of the page's own, posted after the app's, has run once the app has taken it.
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  }, hidden);
  // the idle status poll runs every 30 s: a hide and a show restart it at once, onto the fake
  for (const deadline = Date.now() + 10_000; ;) {
    const restarted = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/updates", { timeout: 2_000 }).then(() => true, () => false);
    await setPageHidden(true);
    await setPageHidden(false);
    if (await restarted) break;
    assert.ok(Date.now() < deadline, "a hide and a show restart the update status poll");
  }
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "About");
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

  // the More menu's Alerts item turns this device's alerts on, and off again (it stayed disabled once on)
  // the header has no button of its own for it, for New tab or for the file browser any more
  assert.equal(await page.locator(".app-header .bell-button, .app-header .new-tab-button, .app-header .files-button").count(), 0, "the three actions are the More menu's items");
  // before the permission question is answered the item already reads as on: in-app alerts show
  assert.equal(await alertsState(page), "On in the app");
  assert.equal(await alertsOffMarked(page), false, "alerts that are on leave the More button unmarked");
  await context.grantPermissions(["notifications"], { origin });
  await runMoreItem(page, "Alerts");
  await until(async () => await alertsState(page) !== "On in the app", "the item's tap takes the permission");
  assert.match(await alertsState(page), /^On[ ,]/);
  assert.equal(await alertsOffMarked(page), false);
  await runMoreItem(page, "Alerts");
  await until(async () => await alertsState(page) === "Off on this device", "alerts off");
  assert.equal(await alertsOffMarked(page), true, "alerts that are off mark the More button, in its dot and its name");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").alertsOn), false);
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null), null, "turning alerts off drops the push subscription");
  await runMoreItem(page, "Alerts");
  await until(async () => /^On[ ,]/.test(await alertsState(page)), "alerts on again");
  assert.equal(await alertsOffMarked(page), false);
  console.log("PASS the Alerts item turns alerts off and on again");

  // where notifications are blocked the item is still there, and switches the in-app alerts
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await blocked.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
  });
  const blockedPage = await blocked.newPage();
  const blockedEvidence = evidenceDirectory ? await watchBrowserEvidence(blocked, blockedPage, "blocked-notifications") : undefined;
  csp.push(await watchCsp(blockedPage));
  await blockedPage.goto(origin);
  await blockedPage.locator(".header-more-button").waitFor();
  assert.equal(await alertsState(blockedPage), "On in the app");
  assert.equal(await alertsOffMarked(blockedPage), false);
  await runMoreItem(blockedPage, "Alerts");
  await until(async () => await alertsState(blockedPage) === "Off on this device", "blocked alerts off");
  assert.equal(await alertsOffMarked(blockedPage), true);
  assert.equal(await blockedPage.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").alertsOn), false);
  await runMoreItem(blockedPage, "Alerts");
  await until(async () => await alertsState(blockedPage) === "On in the app", "blocked alerts on again");
  assert.equal(await alertsOffMarked(blockedPage), false);
  if (blockedEvidence) await blockedEvidence.finish();
  await blocked.close();
  console.log("PASS a device that blocks notifications keeps the Alerts item as the switch for in-app alerts");

  await checkPushSettings(browser, origin);
  await checkWakeLock(browser, origin, paneA);
  await checkSecretInput(browser, origin);
  await checkTerminalCopy(browser, origin);
  await checkUsageMeters(browser, origin);
  await checkNotificationStartup(browser, origin, paneA, paneB);
  await checkNotificationView(browser, origin);
  await checkMobileViewport(browser, origin, paneB);
  await checkMobileTabs(browser, origin);
  await checkDefaultView(browser, origin);
  await checkComposerReconnect(browser, origin, paneB);
  await checkDroplet(browser, origin);
  await checkSplitView(browser, origin);
  await checkTakeOver(browser, origin);
  await checkAlertSound(browser, origin);
  await checkChatKeepsTerminalSize(browser, origin);
  await checkPaneSwitchKeepsTerminalSize(browser, origin);
  await checkBackgroundTabKeepsTerminalSize(browser, origin);
  await checkUpdateNotice(browser, origin);

  // The pending protocol has a real foreground agent and an owned byte recorder: merely
  // reporting an idle shell as working would not prove that server-side queueing happened.
  const pendingCwd = join(root, "pending"); mkdirSync(pendingCwd);
  const pendingWorkspace = await workspaceCreate({ cwd: pendingCwd, label: "herdr-web-ui-test-browser-pending" });
  workspaces.push(pendingWorkspace.workspace.workspace_id);
  const pendingPane = pendingWorkspace.root_pane.pane_id;
  const pendingProgram = join(root, "claude"); copyFileSync(process.execPath, pendingProgram); chmodSync(pendingProgram, 0o755);
  const pendingLog = join(root, "pending-input.jsonl");
  const pendingScreen = join(root, "pending-screen.txt"); writeFileSync(pendingScreen, "");
  const pendingScript = join(root, "pending-agent.cjs");
  writeFileSync(pendingScript, `const fs=require("node:fs");const log=process.argv[2],screen=process.argv[3];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(log,""));process.stdin.on("data",c=>{if(c.includes(3))process.exit(0);fs.appendFileSync(log,JSON.stringify(c.toString("utf8"))+"\\n");});const watch=fs.watch(screen,()=>process.stdout.write("\\x1b[2J\\x1b[H"+fs.readFileSync(screen,"utf8")));process.on("exit",()=>watch.close());`);
  await herdrRpc("pane.send_text", { pane_id: pendingPane, text: `'${pendingProgram}' '${pendingScript}' '${pendingLog}' '${pendingScreen}'\n` });
  await until(() => existsSync(pendingLog), "pending byte recorder started");
  const pendingBytes = () => readFileSync(pendingLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  const reportPending = (state: string) => herdrRpc("pane.report_agent", { pane_id: pendingPane, source: "manual", agent: "claude", state });
  await reportPending("working");
  await page.locator(`.pane-select[title^="${pendingPane} —"]`).click();
  await page.getByRole("group", { name: "Pane view", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await until(async () => await page.locator(".composer-agent-label").innerText() === "Claude", "foreground agent identity reached the composer");
  await pendingReady(pendingPane);
  const pendingRows = page.locator(".pending-messages .pending-message");
  const queuedTexts = ["first pending browser message", "# second pending message", "# third pending message"];
  for (const [index, text] of queuedTexts.entries()) {
    await composer.fill(text);
    assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0, "typing replaces Stop with Send");
    assert.equal(await page.getByRole("button", { name: "Queue message", exact: true }).count(), 0, "there is no separate Queue control");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await pendingRows.count() === index + 1 && await composer.inputValue() === "", "server accepted pending input");
    assert.equal(inputs.at(-1)?.pane_id, pendingPane);
    assert.equal(inputs.at(-1)?.delivery, "queue");
  }
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts);
  assert.equal(pendingBytes(), "", "accepted pending messages have not reached the pty");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 1, "empty working composer returns to Stop");
  assert.equal(await page.locator(".composer-action").count(), 1, "one primary action");
  const actionsBeforeTextClick = pendingActions.length;
  await pendingRows.locator(".pending-message-bubble").first().click();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingActions.length, actionsBeforeTextClick, "pending message text is selectable, not a send action");
  assert.equal(pendingBytes(), "");
  await reportPending("blocked"); await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), "", "blocked status never advances pending input");
  assert.equal(await pendingRows.count(), 3);
  await reportPending("working"); await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingRows.first().getByRole("button", { name: /^Send now:/ }).press("Enter");
  await until(async () => await pendingRows.count() === 2 && pendingBytes().endsWith("\r"), "explicit Send now delivered one item");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`);
  assert.equal(pendingActions.at(-1)?.pane_id, pendingPane);
  assert.equal(await pendingRows.first().getByRole("button", { name: /^Send now:/ }).evaluate((button) => button === document.activeElement), true, "a removed keyboard action hands focus to the next pending action");
  // a draft puts Send where Stop was: Escape in the box is still Stop, once a completion is put away, and keeps the draft
  await composer.fill("/he");
  await composer.press("Escape");
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`, "the first Escape on a command being completed only puts the completion away");
  await composer.fill("a draft while the agent works");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0);
  await composer.press("Escape");
  await until(() => pendingBytes() === `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "Escape with a draft stops the working agent");
  assert.equal(await composer.inputValue(), "a draft while the agent works", "Escape leaves the draft in the box");
  await composer.fill("");
  // a follow-up sent between a reconnect and its snapshot is the new connection's own row, not an unconfirmed copy
  const sentBeforeSnapshot = inputs.length;
  const socketsBeforeReconnect = sockets.length;
  holdSnapshot = true;
  await routed.at(-1)!.close();
  await until(() => releaseSnapshot !== null, "the reconnect's snapshot was held back");
  // the server can send its snapshot before the page has even sent its attach: the pane is
  // ready only once the new connection says so, not by the closed one's last word
  await until(() => sockets.length > socketsBeforeReconnect, "the page opened its new connection");
  await pendingReady(pendingPane);
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "the lost connection's rows are no longer its own");
  await composer.fill("sent before the snapshot");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(inputs.length, sentBeforeSnapshot, "the message waits for the snapshot that says what the bridge supports");
  releaseSnapshot!();
  await until(async () => await page.locator('.pending-message[data-state="queued"]').count() === 1, "the message sent before the snapshot is a live pending row");
  assert.equal(inputs.at(-1)?.delivery, "queue");
  assert.equal(await page.locator(".composer-note").count(), 0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await until(async () => await pendingRows.count() === 2, "the live row was discarded on the bridge");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`);
  await page.reload(); await page.locator(".conn-live").waitFor();
  await until(async () => await pendingRows.count() === 2, "saved pending copies restored");
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts.slice(1));
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "reload removes connection proof");
  assert.equal(await page.locator(".pending-message-send").count(), 0, "unknown delivery cannot be resent");
  await reportPending("idle"); await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "reload and readiness never replay saved pending input");
  for (let left = 2; left > 0; left--) { await page.getByRole("button", { name: "Discard saved copy", exact: true }).first().click(); await until(async () => await pendingRows.count() === left - 1, "discard saved copy"); }
  console.log("PASS Send queues server-owned input, explicit Send now delivers once, and reload/readiness never replay uncertain copies");

  // Older releases saved editable held rows. Seed that documented storage format so the
  // recovery, editing and layout checks continue to cover existing users' retained text.
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  const report = (state: string) => herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state });
  await report("working");
  await page.evaluate(({ pane, texts }) => {
    localStorage.setItem(`herdr-web-ui:queue:${pane}`, JSON.stringify({ version: 1, messages: texts.map((text, index) => ({ id: `legacy-browser-${index}`, text })) }));
  }, { pane: paneA, texts: ["printf 'browser-queue-ok\\n'", "# second queued message", "# third queued message"] });
  await page.reload(); await page.locator(".conn-live").waitFor();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "legacy held rows restored");
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 1);
  assert.equal(await page.locator(".composer-action").count(), 1, "one primary action beside legacy recovery");
  // the held rows sit on the input card's column, under one caption that counts them
  const heldBox = await page.locator(".composer-queue").boundingBox();
  const cardBox = await page.locator(".composer-surface").boundingBox();
  assert.ok(heldBox && cardBox);
  assert.equal(Math.round(heldBox.x), Math.round(cardBox.x));
  assert.equal(Math.round(heldBox.width), Math.round(cardBox.width));
  assert.match(await page.locator(".composer-queue-heading").innerText(), /Held until the agent is ready · 3 messages/);
  assert.equal(await page.locator(".composer-queue-toggle").count(), 0, "no prompt and no short phone: the rows are not folded");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "multiple-queue.png") });
  // one column: the held list, the box and the conversation share their edges, and the status
  // line is the box's own last row, inside it.
  // The default Chat width follows the pane: min 820px, max 60rem (960px at this 16px root), 71% of the pane between. This
  // pane is under 1148px, so the lane is its 820px floor, as at Narrow; at Wide the lane is wider
  // than the pane and the column is the pane less its gutters. A larger window grows the lane
  const chatWidth = async (name: string): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await page.getByRole("group", { name: "Chat width", exact: true }).getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  const laneColumn = async (): Promise<{ x: number; width: number; pane: number }> => {
    const pane = await page.locator(".terminal-stack.is-chat").boundingBox();
    const card = await page.locator(".composer-surface").boundingBox();
    assert.ok(pane && card);
    const [text, left, status, right] = await Promise.all([".composer-text", ".composer-controls-left", ".composer-status", ".composer-controls-right"]
      .map((selector) => page.locator(`.composer-surface > ${selector}`).boundingBox()));
    assert.ok(text && left && status && right, "the message box and the three cells of the controls row");
    // each row spans the card's inner width: inside its hairline border, a fraction of a px either way
    assert.ok(Math.abs(text.x - card.x) <= 2.5 && Math.abs(text.width - card.width) <= 4, `.composer-text spans the box: ${JSON.stringify({ text, card })}`);
    // the status content is the middle cell of the last row: add on its left, the round button on its right, no gap between the cells
    assert.ok(Math.abs(left.x - card.x) <= 2.5 && Math.abs(status.x - (left.x + left.width)) <= 1 && Math.abs(right.x - (status.x + status.width)) <= 1
      && Math.abs(right.x + right.width - left.x - card.width) <= 4, `the controls row spans the box: ${JSON.stringify({ left, status, right, card })}`);
    for (const selector of [".composer-queue", ".chat-transcript"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box, selector);
      assert.equal(Math.round(box.x), Math.round(card.x), `${selector} starts on the box's edge`);
      assert.equal(Math.round(box.width), Math.round(card.width), `${selector} is as wide as the box`);
    }
    return { x: Math.round(card.x), width: Math.round(card.width), pane: Math.round(pane.width) };
  };
  const floor = await laneColumn();
  assert.ok(floor.pane < 1148, "71% of this pane is under the lane's floor");
  assert.equal(floor.width, 820);
  assert.ok(floor.width < floor.pane - 32, "the lane, not the pane, sets the column");
  await chatWidth("Narrow");
  assert.deepEqual(await laneColumn(), floor);
  await chatWidth("Wide");
  const gutters = await laneColumn();
  assert.equal(gutters.width, gutters.pane - 32, "the wide lane is wider than this pane: the column is the pane less its gutters");
  await chatWidth("Default");
  assert.deepEqual(await laneColumn(), floor);
  await page.setViewportSize({ width: 1920, height: 800 });
  await until(async () => Math.round((await page.locator(".composer-surface").boundingBox())?.width ?? 0) === 960, "the default lane grows to its 960px ceiling on a large window");
  assert.equal((await laneColumn()).width, 960);
  await page.setViewportSize({ width: 1280, height: 800 });
  await until(async () => Math.round((await page.locator(".composer-surface").boundingBox())?.width ?? 0) === 820, "the default lane returns to its floor");
  assert.deepEqual(await laneColumn(), floor);
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
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    const toggle = page.getByRole("switch", { name: "Show above the message box", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(show)) await toggle.click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  assert.equal(await page.locator(".composer-quick").count(), 0);
  assert.equal(await page.locator(".composer-quick-toggle").count(), 0);
  await quickRow(true);
  // on a wide pane the row keeps the box's column instead of running to the pane's left edge.
  // Measured at the narrow Chat width, where the lane is narrower than this pane at any window
  // size: in a lane wider than the pane the row and the box would both simply fill the composer
  // whatever their own width rule said
  await chatWidth("Narrow");
  const quickBox = await page.locator(".composer-quick").boundingBox();
  const surfaceBox = await page.locator(".composer-surface").boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  assert.ok(quickBox && surfaceBox && composerBox);
  assert.ok(surfaceBox.width < composerBox.width - 32, "the box is held to the lane, narrower than the pane");
  assert.equal(Math.round(quickBox.x), Math.round(surfaceBox.x));
  assert.equal(Math.round(quickBox.width), Math.round(surfaceBox.width));
  await chatWidth("Default");
  await composer.fill("draft stays");
  const quickCount = inputs.length;
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "continue", exact: true }).click();
  await until(() => inputs.length > quickCount, "quick reply send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  assert.match(inputs.at(-1)!.text, /^continue/);
  assert.equal(await composer.inputValue(), "draft stays");
  // Mid-turn it uses the same real server-owned pending path as Send, and still leaves the draft.
  await page.locator(`.pane-select[title^="${pendingPane} —"]`).click();
  await reportPending("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingReady(pendingPane);
  await composer.fill("draft stays");
  const beforeQuickQueue = pendingBytes();
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "retry", exact: true }).click();
  await until(async () => await pendingRows.count() === 1, "quick reply accepted as pending");
  assert.equal(await pendingRows.locator(".pending-message-bubble").textContent(), "retry");
  assert.equal(await composer.inputValue(), "draft stays");
  assert.equal(pendingBytes(), beforeQuickQueue, "working quick reply is not immediate input");
  await pendingRows.getByRole("button", { name: "Discard", exact: true }).click();
  await until(async () => await pendingRows.count() === 0, "quick reply discarded by id");
  await quickRow(false);
  assert.equal(await page.locator(".composer-quick").count(), 0);
  await composer.fill("");
  await reportPending("idle");
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  assert.equal(await composer.inputValue(), "draft stays", "the other pane's draft stayed with it");
  await composer.fill("");
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
  await checkFolderFilter(page, dialog, () => createRequests);
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

  // Existing git worktrees are discovered through the list API. A new worktree from the row's
  // ⋯ menu appears under the same workspace, using its exact branch rather than its editable label.
  repo = join(root, `herdr-web-ui-test-repo-${process.pid.toString(36)}`);
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=herdr-web-ui test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo ?? undefined, stdout: "pipe", stderr: "pipe" });
  assert.equal(git("init", "-q", "-b", "main").exitCode, 0, "git init");
  writeFileSync(join(repo, "README.md"), "worktree fixture\n");
  assert.equal(git("add", "README.md").exitCode, 0);
  assert.equal(git("commit", "-q", "-m", "fixture").exitCode, 0, "git commit");
  const repoWorkspace = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-repo" });
  workspaces.push(repoWorkspace.workspace.workspace_id);
  const repoRow = workspaceHeader(repoWorkspace.workspace.workspace_id);
  await repoRow.waitFor();
  const initialResponse = await fetch(`${origin}/api/worktree/create`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: repoWorkspace.workspace.workspace_id, branch: "browser/initial", label: "Existing checkout" }),
  });
  assert.equal(initialResponse.status, 200, "an existing branch fixture is created through the owned workspace API");
  const initialWorktree = await initialResponse.json() as WorktreeOpened;
  worktreeWorkspaces.push(initialWorktree.workspace_id);
  const initialRow = page.locator(`.worktree-children .workspace-group[data-workspace="${initialWorktree.workspace_id}"]`);
  await until(async () => await initialRow.locator(".workspace-name").textContent() === "Existing checkout", "a named worktree's row is titled by its workspace name");
  assert.equal(await initialRow.locator(".worktree-workspace-label").textContent(), "browser/initial", "the list API discovers an existing worktree's exact branch, said after the name");
  assert.equal(await repoRow.locator(".workspace-name").textContent(), "herdr-web-ui-test-repo", "the parent keeps its workspace name");
  // A list read from before creation must not erase the branch supplied by the create response.
  let releaseWorktreeList!: () => void;
  const heldWorktreeList = new Promise<void>((resolve) => { releaseWorktreeList = resolve; });
  releases.push(releaseWorktreeList);
  let worktreeListCaptured = false;
  let staleWorktreeListFinished = false;
  let freshWorktreeListFinished = false;
  await page.route("**/api/worktree/list?*", async (route) => {
    const response = await route.fetch();
    if (!worktreeListCaptured) {
      worktreeListCaptured = true;
      await heldWorktreeList;
      await route.fulfill({ response });
      staleWorktreeListFinished = true;
    } else {
      await route.fulfill({ response });
      freshWorktreeListFinished = true;
    }
  });
  await setPageHidden(true);
  await setPageHidden(false);
  await until(() => worktreeListCaptured, "a pre-create worktree inventory is held");
  await repoRow.locator(".workspace-select").click();
  await repoRow.locator(".workspace-toggle").click();
  await initialRow.waitFor({ state: "detached" });
  await repoRow.hover();
  await repoRow.locator(".row-menu-toggle").click();
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
  const newWorktree = page.getByRole("dialog", { name: /^New worktree/ });
  await newWorktree.waitFor();
  // the branch and the name arrive filled in, as herdr's own form fills them, and the name follows the branch
  const suggested = await newWorktree.getByLabel(/^Branch/).inputValue();
  assert.match(suggested, /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), suggested.replace("/", "-"));
  await newWorktree.getByLabel(/^Branch/).fill("browser/sidebar");
  // the agent to start in the checkout is chosen here; the run takes a shell so nothing is launched
  const worktreeAgent = newWorktree.getByRole("combobox", { name: "Agent" });
  await worktreeAgent.click();
  await page.getByRole("option", { name: "Shell", exact: true }).click();
  assert.equal((await worktreeAgent.textContent())?.trim(), "Shell");
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), "browser-sidebar");
  await newWorktree.getByLabel(/^Name/).fill("Sidebar redesign");
  const worktreeResponse = page.waitForResponse((response) => response.url().endsWith("/api/worktree/create"));
  await newWorktree.getByRole("button", { name: "Create worktree", exact: true }).click();
  const worktree = await (await worktreeResponse).json() as WorktreeOpened;
  worktreeWorkspaces.push(worktree.workspace_id);
  assert.equal(worktree.branch, "browser/sidebar");
  await newWorktree.waitFor({ state: "detached" });
  await until(async () => (await page.locator(`.pane-select[title^="${worktree.pane_id} —"]`).getAttribute("aria-current")) === "true", "the worktree's pane is selected");
  const childRow = page.locator(`.worktree-children .workspace-group[data-workspace="${worktree.workspace_id}"]`);
  const childHeader = childRow.locator(":scope > .workspace-header");
  assert.equal(await repoRow.locator(".sidebar-drag-handle").count(), 0, "the parent workspace has no reorder grip column");
  assert.equal(await childHeader.locator(".sidebar-drag-handle").count(), 0, "the branch workspace has no reorder grip column");
  assert.equal(await repoRow.locator(".workspace-select").getAttribute("draggable"), "true", "the parent workspace row supports dragging");
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "true", "the branch workspace row supports dragging");
  await until(async () => await childHeader.locator(".workspace-name").textContent() === "Sidebar redesign", "a newly created child is titled by the name it was given");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "its exact branch, slash included, follows the name");
  assert.equal(await repoRow.locator(".workspace-toggle").getAttribute("aria-expanded"), "true", "creation expands a previously folded parent");
  assert.equal(await page.locator(`.workspace-group[data-workspace="${repoWorkspace.workspace.workspace_id}"] + .worktree-children > .workspace-list > .workspace-group`).count(), 2,
    "existing and newly created branches share their repository workspace");
  assert.equal(await childHeader.locator('.workspace-select[aria-current="true"]').count(), 1, "the created branch is selected");
  assert.equal(staleWorktreeListFinished, false, "the create response displays the branch before the pending list finishes");
  releaseWorktreeList();
  await until(() => staleWorktreeListFinished && freshWorktreeListFinished, "the stale inventory is followed by a fresh one");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "a pre-create inventory cannot erase the new branch");
  assert.equal(await childHeader.locator(".workspace-name").textContent(), "Sidebar redesign", "nor the name it was given");
  await page.unroute("**/api/worktree/list?*");
  await childHeader.hover();
  await childHeader.locator(".row-menu-toggle").click();
  await page.getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
  const worktreeRename = childHeader.getByRole("textbox", { name: "Workspace name", exact: true });
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "false", "an editing field disables row dragging");
  await worktreeRename.fill("Sidebar renamed");
  await worktreeRename.press("Enter");
  await until(async () => await childHeader.locator(".workspace-name").textContent() === "Sidebar renamed", "the child workspace is renamed in its row title");
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "true", "row dragging returns after editing finishes");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "renaming a workspace preserves its actual git branch");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "worktree-branches-sidebar.png") });
  // a workspace row's menu also opens from a right-click on the row
  await repoRow.locator(".workspace-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open worktree…", exact: true }).click();
  const openWorktree = page.getByRole("dialog", { name: /^Open worktree/ });
  await openWorktree.waitFor();
  const entry = openWorktree.locator(".worktree-row", { hasText: "browser/sidebar" });
  await entry.waitFor();
  assert.equal(await entry.locator(".pill").count(), 1, "the open checkout is marked as open");
  await page.keyboard.press("Escape");
  await openWorktree.waitFor({ state: "detached" });
  console.log("PASS existing and new branches sit under their workspace; creation expands the group and workspace renames preserve the branch");

  // Keep one child for the group-aware reorder check; clean up the initial API-created fixture.
  const removeInitial = await fetch(`${origin}/api/worktree/remove`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: initialWorktree.workspace_id }),
  });
  assert.equal(removeInitial.status, 200, "the initial owned checkout is removed");
  await initialRow.waitFor({ state: "detached" });
  worktreeWorkspaces.splice(worktreeWorkspaces.indexOf(initialWorktree.workspace_id), 1);

  // The worktree's row sits under its repository's, as herdr packs them.
  // Its menu deletes the checkout: a dirty one is refused in git's words first, then deleted anyway.
  const repoHeader = repoRow;
  await childRow.waitFor();
  assert.equal(await page.locator(".worktree-children").count(), 1, "one group of worktrees, under the repository's row");
  await herdrRpc("pane.report_agent", { pane_id: worktree.pane_id, source: "manual", agent: "codex", state: "idle" });
  await agentRow(worktree.pane_id).waitFor();
  await repoHeader.locator(".workspace-select").click();
  await repoHeader.locator('.workspace-select[aria-current="true"]').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")?.pane_id),
    repoWorkspace.root_pane.pane_id, "selecting the parent after its branch returns to the parent's own pane");
  const repoToggle = repoHeader.locator(".workspace-toggle");
  await repoToggle.click();
  await childRow.waitFor({ state: "detached" });
  // the folder that leads the row is the fold, and a closed one says how many checkouts it holds
  assert.equal(await repoHeader.evaluate((header) => header.firstElementChild?.classList.contains("workspace-toggle") ?? false), true, "the fold leads the row");
  assert.equal(await repoHeader.locator(".workspace-fold-count").textContent(), "+1");
  assert.equal(await agentRow(worktree.pane_id).isVisible(), true, "folding a worktree group preserves its independent agent");
  await agentRow(worktree.pane_id).locator(".agent-select").click();
  await childHeader.locator('.workspace-select[aria-current="true"]').waitFor();
  assert.equal(await repoToggle.getAttribute("aria-expanded"), "false", "an explicitly selected child remains visible within a folded group");
  await repoToggle.click();
  // reorder is group-aware: the repository's row moves up past the group before it, as one, and
  // its lone worktree has no sibling to move among, so nothing is sent for it
  const moves: number[] = [];
  await page.route("**/api/workspace/move", async (route) => { moves.push(route.request().postDataJSON().insert_index as number); await route.continue(); });
  const orderBefore = (await herdrRpc<{ snapshot: { workspaces: { workspace_id: string }[] } }>("session.snapshot", {})).snapshot.workspaces.map((workspace) => workspace.workspace_id);
  await repoHeader.locator(".workspace-select").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await until(() => moves.length === 1, "the repository's row moved up as a group");
  assert.equal(moves[0], orderBefore.indexOf(repoWorkspace.workspace.workspace_id) - 1, "it lands before the group above it");
  await childHeader.locator(".workspace-select").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(400);
  assert.equal(moves.length, 1, "a lone worktree has nowhere to move");
  await page.unroute("**/api/workspace/move");
  writeFileSync(join(worktree.path, "unsaved.txt"), "dirty\n");
  await childHeader.hover();
  await childHeader.locator(".row-menu-toggle").click();
  const childMenu = page.getByRole("menu");
  await childMenu.waitFor();
  assert.deepEqual(await childMenu.getByRole("menuitem").allTextContents(), ["Rename workspace", "Rename pane", "New tab", "Close workspace", "Delete worktree checkout…"], "a worktree workspace's menu");
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
  console.log("PASS a worktree row sits under its repository's row, and its menu deletes the checkout, asking twice for a dirty one");

  // A second tab from the row's ⋯ menu: the dialog is New tab, with the workspace's folder shown
  // and not asked for; the new pane opens, the workspace stays one row, and a strip over the pane
  // lists both tabs from then on. The header's More menu has New tab too, and opens the same dialog.
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
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-name").textContent(), "herdr-web-ui-test-browser-created",
    "opening another tab preserves the workspace name in Spaces");
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-select").count(), 1,
    "all tabs share the workspace's representative row");
  assert.equal(await workspaceGroup(created.workspace_id).locator(".sidebar-tab-heading").count(), 0,
    "tab labels stay in the terminal tab strip");
  const strip = page.locator(".tab-strip");
  await strip.waitFor();
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["Tab 1", "second"]);
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "second");
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab opens its pane again");
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "Tab 1");
  // reopened right after a creation: its fields are live and Escape puts it away at once
  await runMoreItem(page, "New tab");
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
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-name").textContent(), "herdr-web-ui-test-browser-created",
    "renaming a tab leaves the workspace name unchanged");
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
  const tabPhoneEvidence = evidenceDirectory ? await watchBrowserEvidence(tabPhone, tabPhonePage, "touch-tab-menu") : undefined;
  csp.push(await watchCsp(tabPhonePage));
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
  if (tabPhoneEvidence) await tabPhoneEvidence.finish();
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
  // the card is docked on the composer's column, directly over it, and is no part of the transcript
  assert.deepEqual(await startupPrompt.evaluate((node) => ({
    inTranscript: node.closest(".chat-view") !== null,
    next: node.parentElement?.nextElementSibling?.classList.contains("composer") ?? false,
    over: node.getBoundingClientRect().bottom <= document.querySelector(".composer-surface")!.getBoundingClientRect().top,
  })), { inTranscript: false, next: true, over: true });
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

  // Server-owned Send now drops the old suggestion itself, before a delayed prompt read returns.
  await selectPane(pendingPane);
  await reportPending("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingReady(pendingPane);
  await composer.fill("# queued before the suggestion");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await until(async () => await pendingRows.count() === 1, "suggestion test pending input accepted");
  // A pane switch ends this item's automatic lease. Claude's ready-only suggestion
  // can then appear beside the retained server-owned item without auto-dispatching it.
  await selectPane(paneA); await selectPane(pendingPane);
  await page.locator('.pending-message[data-state="held"]').waitFor();
  await pendingReady(pendingPane);
  await reportPending("idle");
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  const rule = "─".repeat(40);
  writeFileSync(pendingScreen, `${rule}\r\n❯ \u001b[2mcheck the diff\u001b[0m\r\n${rule}\r\n`);
  await until(async () => await composer.getAttribute("placeholder") === "check the diff", "suggestion beside a pending message");
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(pendingPane)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue().catch(() => {});
  });
  const sentAt = Date.now();
  await pendingRows.getByRole("button", { name: /^Send now:/ }).click();
  await until(async () => await composer.getAttribute("placeholder") !== "check the diff", "Send now drops the suggestion");
  assert.ok(Date.now() - sentAt < 2500, "the suggestion goes with the Send now, not with a later read");
  await pendingRows.waitFor({ state: "hidden" });
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(pendingPane)}`);
  await herdrRpc("pane.send_text", { pane_id: pendingPane, text: "\u0003" });
  await workspaceClose(pendingWorkspace.workspace.workspace_id);
  workspaces.splice(workspaces.indexOf(pendingWorkspace.workspace.workspace_id), 1);
  await selectPane(paneA);
  console.log("PASS Send now on a server-owned pending message drops Claude's suggestion");

  // Split view (lib/split.ts): a sidebar row dragged to the right half opens its pane there beside
  // the one open, each half with its own conversation; a press in the other half makes it the
  // active one without moving either pane, and closing a half leaves one pane
  // (after the steps that take the newest socket for the page's own: the other half opens one)
  {
    await selectPane(paneA);
    const area = page.locator(".pane-split");
    const box = (await area.boundingBox())!;
    await page.locator(`.pane-select[title^="${paneB} —"]`).dragTo(area, { targetPosition: { x: box.width * 0.8, y: box.height / 2 } });
    await until(async () => await page.locator(".pane-slot").count() === 2, "two halves after the drop");
    const half = (side: string) => page.locator(`.pane-slot[data-side="${side}"]`);
    await half("left").getByRole("log", { name: `conversation of ${paneA}`, exact: true }).waitFor();
    await half("right").getByRole("log", { name: `conversation of ${paneB}`, exact: true }).waitFor();
    assert.equal(await half("right").evaluate((slot) => slot.classList.contains("is-active")), true, "the dropped pane's half is active");
    assert.equal(await page.locator(".pane-select[aria-current=\"true\"]").getAttribute("title").then((title) => title?.startsWith(`${paneB} —`)), true, "and its pane is the selected one");
    const [left, right] = await Promise.all([half("left").boundingBox(), half("right").boundingBox()]);
    assert.ok(left && right && Math.abs(left.width - right.width) <= 2 && left.x + left.width <= right.x + 1, "the halves share the pane area side by side");
    await half("left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
    await until(async () => await half("left").evaluate((slot) => slot.classList.contains("is-active")), "a press makes the left half active");
    // the header speaks for the active half's connection, handed over by a terminal that was already connected
    await page.locator(".conn.conn-live").waitFor();
    await half("left").getByRole("log", { name: `conversation of ${paneA}`, exact: true }).waitFor();
    await half("right").getByRole("log", { name: `conversation of ${paneB}`, exact: true }).waitFor();
    assert.match(await page.evaluate(() => localStorage.getItem("herdr-web-ui:split") ?? ""), /"active":"a"/, "the split is kept for a reload");
    await half("right").getByRole("button", { name: "Close this half", exact: true }).click();
    await until(async () => await page.locator(".pane-slot").count() === 1, "one pane after closing a half");
    assert.equal(await page.evaluate(() => localStorage.getItem("herdr-web-ui:split")), null);
    await page.getByRole("log", { name: `conversation of ${paneA}`, exact: true }).waitFor();
  }
  console.log("PASS a dragged row opens its pane beside the open one; a press switches the active half; a half closes");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
  });
  const mobilePage = await mobile.newPage();
  const mobileEvidence = evidenceDirectory ? await watchBrowserEvidence(mobile, mobilePage, "mobile-storage-unavailable") : undefined;
  csp.push(await watchCsp(mobilePage));
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await mobilePage.locator(".conn-live").waitFor();
  const tapHighlight = await mobilePage.locator(".view-switch button").first().evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-tap-highlight-color"));
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
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "the chat, the composer and the phone views load with no CSP violation");
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
  assert.equal(await mobilePage.locator(".agents-sidebar .agent-section-toggle").getAttribute("aria-expanded"), "false", "a phone's drawer opens with Agents folded");
  await mobilePage.locator(`.pane-select[title^="${paneB} —"]`).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  console.log("PASS a pane picked on a phone waits for a tap before raising the keyboard");

  // Claude's suggestion on a phone is the placeholder and a chip that fills the box, until Settings turns the chip off
  const promptRoute = `**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`;
  const suggest = { json: { prompt: null, suggestion: "run the tests" } };
  const mobileComposer = mobilePage.getByRole("textbox", { name: "Message", exact: true });
  await mobilePage.route(promptRoute, (route) => route.fulfill(suggest));
  await mobileComposer.fill("");
  await until(async () => await mobileComposer.getAttribute("placeholder") === "run the tests", "a phone shows the suggestion as the placeholder");
  assert.equal(await mobilePage.locator(".voice-mic").count(), 0, "a phone's chat has no mic until Settings asks for it");
  await mobilePage.getByTitle("Use the suggestion", { exact: true }).click();
  assert.equal(await mobileComposer.inputValue(), "run the tests", "the chip puts the suggestion in the box");
  await mobilePage.unroute(promptRoute);
  try { await mobileEvidence?.finish(); } finally { await mobile.close(); }
  const plainPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await plainPhone.addInitScript(() => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showSuggestionChip: false })); });
  const plainPage = await plainPhone.newPage();
  const plainEvidence = evidenceDirectory ? await watchBrowserEvidence(plainPhone, plainPage, "suggestion-chip-off") : undefined;
  csp.push(await watchCsp(plainPage));
  plainPage.on("pageerror", (error) => errors.push(error.message));
  await plainPage.route(promptRoute, (route) => route.fulfill(suggest));
  await plainPage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await plainPage.locator(".conn-live").waitFor();
  await plainPage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  const plainComposer = plainPage.getByRole("textbox", { name: "Message", exact: true });
  await until(async () => await plainComposer.getAttribute("placeholder") === "run the tests", "the suggestion stays the placeholder with the chip off");
  assert.equal(await plainPage.getByTitle("Use the suggestion", { exact: true }).count(), 0, "no suggestion chip once Settings turns it off");
  if (plainEvidence) await plainEvidence.finish();
  await plainPhone.close();
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "the suggestion chip loads with no CSP violation");
  console.log("PASS a phone offers Claude's suggestion as a chip until Settings turns it off");

  await checkTerminalInput(browser, origin, paneA, paneB);
  await checkSafariIme(browser, origin, paneA, paneB);
  await checkHeldDraftPaneSwitch(browser, origin, paneA, paneB);

  // the terminal lens on a touch screen: an input line sends whole lines; the grid raises no keyboard
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touch.newPage();
  const touchEvidence = evidenceDirectory ? await watchBrowserEvidence(touch, touchPage, "touch-terminal-input") : undefined;
  csp.push(await watchCsp(touchPage));
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
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "touch terminal input loads with no CSP violation");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await touchPage.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-input-mobile.png") });
  }
  if (touchEvidence) await touchEvidence.finish();
  await touch.close();
  console.log("PASS touch terminal input line sends whole lines, Enter alone, and yields to direct typing");

  // A closed pane and an obsolete saved pane both yield to a live pane. Local access
  // is automatic, so it must not offer a sign-out action that cannot lock the app.
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  // closed from the row's ⋯ menu; the workspace's pane goes with it, so a confirm asks first
  await page.locator(".pane-item.is-selected .row-menu-toggle").click();
  const rowMenu = page.getByRole("menu");
  await rowMenu.waitFor();
  // Escape puts the menu away and the focus back on its button; Enter there opens it again
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("row-menu-toggle") ?? false), true, "Escape returns focus to the row's ⋯");
  // a right-click on the row opens the same menu, under the same button
  await page.locator(".pane-item.is-selected .pane-select").click({ button: "right" });
  await rowMenu.waitFor();
  assert.equal(await page.locator(".pane-item.is-selected .row-menu-toggle").getAttribute("aria-expanded"), "true", "a right-click opens the row's own menu");
  // the press left the focus on the row; the menu takes it a frame later
  await until(async () => await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"), "the menu takes the focus");
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("row-menu-toggle") ?? false), true, "Escape after a right-click returns focus to the row's ⋯");
  await page.keyboard.press("Enter");
  await rowMenu.getByRole("menuitem", { name: "Close workspace", exact: true }).click();
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
  await rowMenu.getByRole("menuitem", { name: "Close workspace", exact: true }).click();
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
  // the desktop page ran past the phone steps above: close it on the same gate
  assertCspClean(csp, "the desktop shell, the file viewer and the pane close load with no CSP violation");
  if (pageEvidence) await pageEvidence.finish();
  await page.close();

  const secured = createServer({ port: 0, hostname: "127.0.0.1", token: "browser-test-token", stateDir: join(root, "secured"), tailscaleOwner: null });
  releases.push(() => secured.stop());
  const securedOrigin = `http://127.0.0.1:${secured.port}`;
  const securedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Use a new pane so this bridge never competes with the first server's attachments.
  const securedWorkspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-browser-signout" });
  workspaces.push(securedWorkspace.workspace.workspace_id);
  const securedPage = await securedContext.newPage();
  const securedEvidence = await watchBrowserEvidence(securedContext, securedPage, "token-gate-signout");
  csp.push(await watchCsp(securedPage));
  await securedContext.request.post(`${securedOrigin}/api/auth`, { data: { token: "browser-test-token" } });
  await securedPage.goto(`${securedOrigin}/?pane=${encodeURIComponent(securedWorkspace.root_pane.pane_id)}`);
  await securedPage.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await securedPage.keyboard.press("ControlOrMeta+Shift+K");
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
  if (securedEvidence) await securedEvidence.finish();
  await securedContext.close();
  assertCspClean(csp, "the token gate loads with no CSP violation");
  console.log("PASS token and paired-device sign out return to the access gate");
} catch (error) {
  for (const evidence of evidenceSessions) {
    if (evidence.isOpen()) await evidence.captureFailure(error);
  }
  throw error;
} finally {
  for (const evidence of evidenceSessions) await evidence.finish();
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
