import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Route, WebSocket } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * The split view's edges (lib/split.ts), each on a browser context of its own: the other half's
 * connection is a second socket, which the main browser run would take for the page's own.
 * Every wait is on a condition: a check that something did not happen waits first for a later
 * event that the same path would have shown after it.
 */
export async function checkSplitView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-split-"));
  const workspaces: string[] = [];
  const contexts: BrowserContext[] = [];
  const panesFor = async (...suffixes: string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const suffix of suffixes) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-split-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      ids.push(created.root_pane.pane_id);
      await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    }
    return ids;
  };
  const open = async (panes: string[], view: "chat" | "terminal", before?: (context: BrowserContext) => Promise<unknown>): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    contexts.push(context);
    await context.addInitScript(([ids, lens]) => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      for (const id of ids as string[]) localStorage.setItem(`herdr-web-ui:view:${id}`, lens as string);
    }, [panes, view] as const);
    await before?.(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes[0]!)}`);
    await page.locator(".conn-live").waitFor();
    return { page, errors };
  };
  const half = (page: Page, side: string) => page.locator(`.pane-slot[data-side="${side}"]`);
  const isActive = (page: Page, side: string) => page.waitForFunction((which) => document.querySelector(`.pane-slot[data-side="${which}"]`)?.classList.contains("is-active") === true, side);
  /** the pane dropped on the right half, which is then the active one */
  const splitRight = async (page: Page, pane: string): Promise<void> => {
    const area = page.locator(".pane-split");
    const box = (await area.boundingBox())!;
    await page.locator(`.pane-select[title^="${pane} —"]`).dragTo(area, { targetPosition: { x: box.width * 0.8, y: box.height / 2 } });
    await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
    await isActive(page, "right");
  };
  /** two frames: what a render commits, and the effects after it, have run */
  const settled = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** polls a condition held outside the page, with a bound */
  const until = async (page: Page, check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
  };

  try {
    // 1. An alert is skipped for the pane in the other half only while that half is drawn.
    {
      const [openPane, otherPane, probe] = await panesFor("open", "other", "probe") as [string, string, string];
      const { page, errors } = await open([openPane, otherPane, probe], "chat");
      const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
      const row = (pane: string, status: string) => page.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first();
      const block = async (pane: string) => {
        await report(pane, "working");
        await row(pane, "working").waitFor({ state: "attached" });
        await report(pane, "blocked");
        await row(pane, "blocked").waitFor({ state: "attached" });
      };
      const unblock = async (pane: string) => {
        await report(pane, "idle");
        await row(pane, "blocked").waitFor({ state: "detached" });
      };
      // a later status the app shows only after it has handled the block: no card by then is none at all
      const handled = async () => {
        await report(probe, "working");
        await row(probe, "working").waitFor({ state: "attached" });
        await settled(page);
        await report(probe, "idle");
      };
      const card = page.locator(".droplet-card");

      await splitRight(page, otherPane);
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await block(otherPane);
      await handled();
      assert.equal(await card.count(), 0, "no in-app alert for the pane drawn in the other half");
      await unblock(otherPane);

      // a window too narrow for the split shows the active half alone: the other pane alerts again
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await block(otherPane);
      await card.waitFor({ state: "visible" });
      assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
      await unblock(otherPane);
      console.log("PASS the other half's pane is spared alerts only while that half is drawn");

      // 2. A Tab onto a control of the inactive half makes the half active and keeps the focus there.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="right"]')?.classList.contains("is-inactive") === true);
      // a focus right after a key, as a Tab gives one: the key and the focus in one task, so the
      // focus is the user's own however slow the run (KEY_FOCUS_MS)
      const attach = half(page, "right").getByRole("button", { name: "Attach files", exact: true });
      await attach.evaluate((button) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        (button as HTMLElement).focus();
      });
      await isActive(page, "right");
      await settled(page);
      assert.equal(await attach.evaluate((button) => button === document.activeElement), true, "the focus stays on the control it went to");
      console.log("PASS a Tab into the inactive half makes it active and keeps the focus where it went");
      assert.deepEqual(errors, []);
    }

    // 3. An upload that finishes in the half the user left does not take the keyboard back.
    {
      const [left, right] = await panesFor("upload-left", "upload-right") as [string, string];
      let held: Route | null = null;
      const { page, errors } = await open([left, right], "terminal", (context) => context.route("**/api/pane/image**", (route) => { held = route; }));
      await splitRight(page, right);
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      // a file dropped on the left terminal; its upload is held in flight
      await half(page, "left").locator(".pane-terminal").evaluate((host) => {
        const data = new DataTransfer();
        data.items.add(new File(["split view"], "split-note.txt", { type: "text/plain" }));
        host.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      await until(page, () => held !== null, "the upload starts");
      // the user moves to the right half, then the upload finishes
      await half(page, "right").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "right");
      const uploaded = page.waitForResponse((response) => response.url().includes("/api/pane/image"));
      await (held as unknown as Route).continue();
      await uploaded;
      await settled(page);
      assert.equal(await half(page, "right").evaluate((slot) => slot.classList.contains("is-active")), true, "the right half stays active");
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.pane-slot[data-side="right"]') !== null), true, "the keyboard stays in the right half");
      console.log("PASS an upload finishing in the half the user left does not take the keyboard back");
      assert.deepEqual(errors, []);
    }

    // 4. Closing the other half leaves the active pane on its own connection.
    {
      const [left, right] = await panesFor("keep-left", "keep-right") as [string, string];
      const sockets: WebSocket[] = [];
      const { page, errors } = await open([left, right], "chat", async (context) => {
        context.on("page", (opened) => opened.on("websocket", (socket) => sockets.push(socket)));
      });
      await splitRight(page, right);
      await half(page, "right").getByRole("log", { name: `conversation of ${right}`, exact: true }).waitFor();
      assert.equal(sockets.length, 2, "one socket per half");
      const [first, second] = sockets as [WebSocket, WebSocket];
      // the right half is active: closing the left one must not move its pane to the left's socket
      await half(page, "left").getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await until(page, () => first.isClosed() || second.isClosed(), "a half's socket closes");
      assert.equal(second.isClosed(), false, "the active half keeps its connection");
      assert.equal(first.isClosed(), true, "the closed half's connection goes");
      await page.getByRole("log", { name: `conversation of ${right}`, exact: true }).waitFor();
      console.log("PASS closing the other half leaves the active pane on its own connection");
      assert.deepEqual(errors, []);
    }

    // 5. Each half keeps its own connection's role: the active half's socket told to watch (a forged
    //    role-ack, as a watch-only answer) leaves the other half's socket interactive.
    {
      const [left, right] = await panesFor("watch-left", "watch-right") as [string, string];
      const { page, errors } = await open([left, right], "chat", async (context) => {
        let sockets = 0;
        await context.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
          const second = sockets++ === 1;
          const upstream = socket.connectToServer();
          upstream.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            socket.send(second && message.type === "role-ack" ? JSON.stringify({ ...message, mode: "observe" }) : raw);
          });
        });
      });
      await splitRight(page, right);
      await half(page, "right").locator(".terminal-banner-observe").waitFor();
      // the render that shows the right half watching is the one that decides the left half's role
      assert.equal(await half(page, "right").getAttribute("data-role"), "observe");
      assert.equal(await half(page, "left").getAttribute("data-role"), "interact", "the other half's socket stays interactive");
      await half(page, "left").locator(".composer textarea").waitFor();
      assert.equal(await half(page, "left").locator(".terminal-banner-observe").count(), 0);
      console.log("PASS each half keeps its own connection's role");
      assert.deepEqual(errors, []);
    }
  } finally {
    for (const context of contexts) await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
