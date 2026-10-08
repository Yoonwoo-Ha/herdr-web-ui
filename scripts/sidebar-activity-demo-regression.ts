import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// Settings → Agents order (Activity) and Quiet opened finishes, on the unmodified app over the
// demo's fixture transport, whose agents carry herdr's state_change_seq and bump it on every state
// change. The demo's Claude pane finishes by itself 4.5s in (site/demo/transport.ts), and a message
// sent from a chat runs for 2.4s and then finishes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-activity-demo-"));

const API = "Idempotent payments";        // claude, working, finishes by itself
const WEB = "Guard the export button";    // codex, blocked
const INFRA = "Why did the backup fail?"; // idle: the agent a message is sent from
const AGENTS_HERDR_ORDER = [API, WEB, INFRA, "Proofread the guide", "Ship the retry flag"];

const agents = (page: Page) => page.locator(".agents-sidebar .agent-item");
const agentTitles = (page: Page) => agents(page).locator(".agent-title").allTextContents();
const agent = (page: Page, title: string) => agents(page).filter({ has: page.locator(".agent-title", { hasText: title }) });
const agentStatus = (page: Page, title: string) => agent(page, title).locator(".sidebar-status").getAttribute("data-status");
const workspaceStatus = (page: Page, label: string) => page.locator(".machine-workspaces .workspace.pane-item", { has: page.locator(`.workspace-select:has-text("${label}")`) }).first().locator(".sidebar-status").first().getAttribute("data-status");
const waitStatus = (page: Page, title: string, status: string) => agent(page, title).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 10_000 });
const waitAgentAt = (page: Page, index: number, title: string) => page.waitForFunction(([at, name]) =>
  [...document.querySelectorAll(".agents-sidebar .agent-item .agent-title")][at as number]?.textContent === name, [index, title] as const, { timeout: 5_000 });

/**
 * `seen`: a record already in this browser, so first-use seeding does not run. Seeding counts what
 * is open at the first roster as opened, and a page slower than the demo's 4.5s self-finish would
 * count that finish too (#529 review): a record there already makes the run independent of load time.
 */
async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>, seen?: Record<string, number>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  try {
    await context.addInitScript(([stored, record]) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
      if (record && localStorage.getItem("herdr-web-ui:seen:local") === null) localStorage.setItem("herdr-web-ui:seen:local", JSON.stringify(record));
    }, [settings, seen] as const);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen, so the demo's own finish happens out of sight
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await agents(page).first().waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // Default: herdr's order before and after a finish, and an opened DONE keeps herdr's dot
      await withPage(browser, {}, async (page) => {
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        await waitStatus(page, API, "done");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "a finish does not move an agent");
        await agent(page, API).locator(".agent-select").click();
        await page.waitForTimeout(500);
        assert.equal(await agentStatus(page, API), "done", "herdr's DONE stands until herdr itself shows the pane");
      });
      console.log("PASS by default the Agents list keeps herdr's order, and an opened DONE keeps its dot");

      await withPage(browser, { agentOrder: "activity", quietOpenedDone: true }, async (page) => {
        assert.equal((await agentTitles(page))[0], WEB, "the blocked agent is pinned on top");

        // the demo's Claude pane finishes out of sight: it rises under the blocked one, and keeps its dot
        await waitStatus(page, API, "done");
        await waitAgentAt(page, 1, API);

        // a message sent from an agent takes it to the top while it runs ...
        await agent(page, INFRA).locator(".agent-select").click();
        await page.locator(".composer-text").fill("Check the backup again");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitAgentAt(page, 1, INFRA);
        // ... and keeps it there when it finishes while another pane is open, with its dot
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        await waitStatus(page, INFRA, "done");
        assert.equal((await agentTitles(page))[1], INFRA, "the agent just worked in stays on top after it finishes");

        // opening it quiets its DONE in both lists; one never opened keeps its dot
        await agent(page, INFRA).locator(".agent-select").click();
        await waitStatus(page, INFRA, "idle");
        assert.equal(await workspaceStatus(page, "infra"), "idle", "its workspace row reads ready too");
        assert.equal(await agentStatus(page, API), "done", "a finish never opened keeps its dot");
        // the run starts from an empty record: the opened finish is in it at herdr's counter for that
        // finish (a look made at a stand-in is saved once a roster read brings the counter), the
        // unopened one is not
        const finishSeq = await page.evaluate(async (paneId) => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { agents: { pane_id: string; state_change_seq?: number }[] } };
          return snapshot.agents.find((entry) => entry.pane_id === paneId)?.state_change_seq;
        }, panes.infra);
        assert.ok(Number.isSafeInteger(finishSeq), `the finished agent carries a counter: ${finishSeq}`);
        await page.waitForFunction(([paneId, seq]) => (JSON.parse(localStorage.getItem("herdr-web-ui:seen:local") ?? "{}") as Record<string, number>)[paneId] === seq,
          [panes.infra, finishSeq!] as const, { timeout: 10_000 });
        const record = JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:seen:local") ?? "{}")) as Record<string, number>;
        assert.equal(record[panes.api], undefined, `the unopened finish is not recorded: ${JSON.stringify(record)}`);

        // a finish watched on screen stays quiet after another pane is opened before the roster
        // read brings herdr's counter for it (#529 review): the look follows the counter. Roster
        // reads are held for that window, so the statuses come by push alone, as they do between reads
        await page.evaluate(() => {
          const page = window as unknown as { holdRoster: boolean; releaseRoster: () => void };
          const inner = window.fetch.bind(window);
          const waiting: Array<() => void> = [];
          page.holdRoster = true;
          page.releaseRoster = () => { page.holdRoster = false; for (const resume of waiting.splice(0)) resume(); };
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (page.holdRoster && /\/api\/(machines|session)\b/.test(target)) await new Promise<void>((resume) => waiting.push(resume));
            return inner(input, init);
          }) as typeof fetch;
        });
        await page.locator(".composer-text").fill("And once more");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitStatus(page, INFRA, "idle");
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        // the held reads go through, and a visibility change asks for one more: herdr's counter arrives
        await page.evaluate(() => {
          (window as unknown as { releaseRoster: () => void }).releaseRoster();
          document.dispatchEvent(new Event("visibilitychange"));
        });
        for (const deadline = Date.now() + 2_000; Date.now() < deadline;) {
          assert.equal(await agentStatus(page, INFRA), "idle", "a finish watched on screen does not get its dot back");
          await page.waitForTimeout(100);
        }
      }, {});
      console.log("PASS Activity pins blocked and follows recency; an opened DONE reads as ready in both lists, an unopened one keeps its dot");

      // the demo keeps its agent template after its last agent closes (#529 review): a workspace
      // made in an emptied demo still lists its agent with herdr's counter
      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        const made = await page.evaluate(async () => {
          const post = (path: string, body: object) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const session = async () => (await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[]; agents: { pane_id: string; state_change_seq?: number }[] };
          for (const { workspace_id } of (await session()).workspaces) await post("/api/workspace/close", { workspace_id, close_group: true });
          const created = await (await post("/api/workspace/create", { cwd: "/home/demo/fresh", agent: { kind: "claude" } })).json() as { pane_id: string };
          return { created: created.pane_id, agents: (await session()).agents };
        });
        const entry = made.agents.find((candidate) => candidate.pane_id === made.created);
        assert.ok(entry && Number.isSafeInteger(entry.state_change_seq), `the new agent carries a counter: ${JSON.stringify(made)}`);
        await agent(page, "fresh").waitFor();
      });
      console.log("PASS a workspace made after the demo's last agent closed is listed with herdr's counter");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
