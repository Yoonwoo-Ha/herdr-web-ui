import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Route, WebSocket } from "playwright-core";
import { herdrRpc, paneSplit, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

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
  const open = async (panes: string[], view: "chat" | "terminal", before?: (context: BrowserContext) => Promise<unknown>, options: { blockViewWrites?: boolean; platform?: string } = {}): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    contexts.push(context);
    await context.addInitScript(([ids, lens, blockViewWrites, platform]) => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      for (const id of ids as string[]) localStorage.setItem(`herdr-web-ui:view:${id}`, lens as string);
      if (blockViewWrites) {
        const setItem = Storage.prototype.setItem;
        Object.defineProperty(Storage.prototype, "setItem", {
          configurable: true,
          value(this: Storage, key: string, value: string) {
            if (this === localStorage && key.startsWith("herdr-web-ui:view:")) throw new DOMException("Storage disabled", "SecurityError");
            setItem.call(this, key, value);
          },
        });
      }
      if (platform !== null) Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
    }, [panes, view, options.blockViewWrites === true, options.platform ?? null] as const);
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

    // 4. Closing the other half leaves the active half's pane mounted, on the PC's one connection.
    {
      const [left, right] = await panesFor("keep-left", "keep-right") as [string, string];
      const sockets: WebSocket[] = [];
      const { page, errors } = await open([left, right], "chat", async (context) => {
        context.on("page", (opened) => opened.on("websocket", (socket) => sockets.push(socket)));
      });
      await splitRight(page, right);
      const kept = (await half(page, "right").locator(".pane-terminal").elementHandle())!;
      await half(page, "right").getByRole("log", { name: `conversation of ${right}`, exact: true }).waitFor();
      // both halves are on this PC: they share its connection (lib/machineSession.ts)
      assert.equal(sockets.length, 1, "one socket for the PC, whatever the halves");
      // the right half is active: closing the left one must not mount its pane again
      await half(page, "left").getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await settled(page);
      assert.equal(await kept.evaluate((element) => element.isConnected), true, "the active half's terminal stays mounted");
      assert.equal(sockets[0]!.isClosed(), false, "the PC's connection stays open");
      await page.getByRole("log", { name: `conversation of ${right}`, exact: true }).waitFor();
      console.log("PASS closing the other half leaves the active pane mounted on its connection");
      assert.deepEqual(errors, []);
    }

    // 5. The guide starts with the pane drag, keeps a stable side around the centre, and leaves
    //    the pane alone when cancelled. Synthetic events let the check visit exact pixel edges.
    {
      const [opened, dragged] = await panesFor("preview-open", "preview-dragged") as [string, string];
      const { page, errors } = await open([opened, dragged], "chat");
      const area = page.locator(".pane-split");
      const guide = page.locator(".split-drop");
      const source = page.locator(`.pane-select[title^="${dragged} —"]`);
      await source.waitFor();
      await guide.waitFor({ state: "attached" });
      const box = (await area.boundingBox())!;
      const middle = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const data = await page.evaluateHandle(() => new DataTransfer());
      const preview = async (visible: boolean, side: "left" | "right" | null): Promise<void> => {
        await settled(page);
        await page.waitForFunction(([shown, target]) => {
          const element = document.querySelector(".split-drop");
          return element?.classList.contains("is-visible") === shown && element.getAttribute("data-side") === target;
        }, [visible, side] as const);
      };
      const start = async (): Promise<void> => {
        // The sidebar's own handler fills the transfer before App's window listener reads it.
        await source.dispatchEvent("dragstart", { dataTransfer: data });
        await preview(true, null);
      };
      const hover = async (x: number, side: "left" | "right"): Promise<void> => {
        await area.dispatchEvent("dragover", { dataTransfer: data, clientX: x, clientY: y });
        await preview(true, side);
      };
      const unchanged = async (): Promise<void> => {
        await preview(false, null);
        assert.equal(await page.locator(".pane-slot").count(), 1, "cancelling does not create a half");
        await page.getByRole("log", { name: `conversation of ${opened}`, exact: true }).waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:split")), null, "cancelling does not save a split");
      };

      await preview(false, null);
      assert.equal(await guide.locator(".split-drop-half").count(), 2, "both drop guides stay mounted");
      assert.equal(await guide.locator(".split-drop-target").count(), 1, "one indicator moves between the guides");
      const indicator = (await guide.locator(".split-drop-target").elementHandle())!;
      await start();
      await hover(middle + 40, "right");
      await area.locator(".pane-slot").first().dispatchEvent("dragleave", {
        dataTransfer: data, relatedTarget: null, clientX: middle + 40, clientY: y,
      });
      await preview(true, "right");
      await area.dispatchEvent("dragleave", { dataTransfer: data, relatedTarget: null, clientX: box.x - 1, clientY: y });
      await preview(true, null);
      await hover(middle - 40, "left");
      assert.equal(await indicator.evaluate((element) => element.isConnected), true, "the indicator is not replaced when the side changes");
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await unchanged();

      for (const cancel of ["outside-drop", "blur", "Escape"] as const) {
        await start();
        await hover(middle + 40, "right");
        if (cancel === "outside-drop") await page.locator("body").dispatchEvent("drop", { dataTransfer: data });
        else if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else await page.keyboard.press("Escape");
        await unchanged();
      }

      // Text and files still belong to their existing input handlers, not the split guide.
      for (const kind of ["text", "file"] as const) {
        const otherData = await page.evaluateHandle((type) => {
          const transfer = new DataTransfer();
          if (type === "text") transfer.setData("text/plain", "selected text");
          else transfer.items.add(new File(["preview"], "preview.txt", { type: "text/plain" }));
          return transfer;
        }, kind);
        await page.locator("body").dispatchEvent("dragstart", { dataTransfer: otherData });
        await area.dispatchEvent("dragover", { dataTransfer: otherData, clientX: middle + 40, clientY: y });
        await unchanged();
        await page.locator("body").dispatchEvent("dragend", { dataTransfer: otherData });
        await otherData.dispose();
      }

      await page.setViewportSize({ width: 768, height: 800 });
      await source.dispatchEvent("dragstart", { dataTransfer: data });
      await area.dispatchEvent("dragover", { dataTransfer: data, clientX: 500, clientY: y });
      await unchanged();
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await start();
      await hover(middle - 40, "left");
      const durations = await guide.evaluate((element) => [element, element.querySelector(".split-drop-target")!]
        .flatMap((node) => getComputedStyle(node).transitionDuration.split(",").map((value) => Number.parseFloat(value))));
      assert.equal(durations.every((duration) => duration === 0), true, "reduced motion removes guide and indicator transitions");
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await unchanged();
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await start();
      await hover(middle - 40, "left");
      await hover(middle + 1, "left");
      await hover(middle + 40, "right");
      await hover(middle - 1, "right");
      // Drop just to the left of the centre while the stable preview still points right.
      await area.dispatchEvent("drop", { dataTransfer: data, clientX: middle - 1, clientY: y });
      await preview(false, null);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await half(page, "right").getByRole("log", { name: `conversation of ${dragged}`, exact: true }).waitFor();
      await isActive(page, "right");
      await data.dispose();
      console.log("PASS split preview starts early, survives child leaves, cancels cleanly and matches the drop side");
      assert.deepEqual(errors, []);
    }

    // 6. A tab dragged down out of its strip opens in a half; the strip keeps its sideways reorder.
    //    Each half draws its tab at herdr's own layout, and a tab is never drawn in both halves.
    {
      const [first] = await panesFor("tabs") as [string];
      const workspaceId = workspaces[workspaces.length - 1]!;
      const second = (await tabCreate({ workspaceId })).root_pane.pane_id;
      await herdrRpc("pane.report_agent", { pane_id: second, source: "manual", agent: "claude", state: "idle" });
      const beside = (await paneSplit(first, "right", false)).pane_id;
      const { page, errors } = await open([first, second, beside], "terminal");
      const area = page.locator(".pane-split");
      await page.waitForFunction(() => document.querySelectorAll(".pane-split .pane-terminal").length === 2);
      const tabs = page.locator(".tab-strip [role=tab]");
      await tabs.nth(1).waitFor();
      const box = (await area.boundingBox())!;
      const tab = (await tabs.nth(1).boundingBox())!;
      await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await page.mouse.down();
      await page.mouse.move(tab.x + tab.width / 2 + 8, tab.y + tab.height / 2 + 4, { steps: 2 });
      // the guide shows as soon as the drag starts, with no half chosen over the strip
      await page.waitForFunction(() => { const guide = document.querySelector(".split-drop"); return guide?.classList.contains("is-visible") && !guide.hasAttribute("data-side"); });
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") === "right");
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await isActive(page, "right");
      assert.equal(await half(page, "left").locator(".pane-terminal").count(), 2, "the left half draws herdr's split of its tab");
      assert.equal(await half(page, "right").locator(".pane-terminal").count(), 1);
      // the other half's tab, picked in the active half's strip, makes that half active: not drawn twice
      await half(page, "right").locator(".tab-strip [role=tab]").nth(0).click();
      await isActive(page, "left");
      assert.equal(await page.locator(".pane-slot").count(), 2);
      assert.equal(await page.locator(".pane-split .pane-terminal").count(), 3, "no tab drawn in both halves");
      // Escape drops a tab drag (from the other half's strip) with nothing changed
      const again = (await half(page, "right").locator(".tab-strip [role=tab]").nth(1).boundingBox())!;
      await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") === "left");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible") === false);
      await page.mouse.up();
      await settled(page);
      // the press made its half active, as any press in the other half does; the drag changed nothing
      await isActive(page, "right");
      assert.equal(await page.locator(".pane-slot").count(), 2);
      assert.equal(await half(page, "left").locator(".pane-terminal").count(), 2, "a cancelled drag leaves the halves alone");
      console.log("PASS a tab dragged out of its strip opens in a half, at herdr's layout, never in both");
      assert.deepEqual(errors, []);
    }

    // 7. A second page in the same browser context cannot replace this page's split.
    {
      const [first, firstOther, second, secondOther] = await panesFor("tab-one", "tab-one-other", "tab-two", "tab-two-other") as [string, string, string, string];
      const { page: firstPage, errors: firstErrors } = await open([first, firstOther, second, secondOther], "chat");
      const secondPage = await firstPage.context().newPage();
      const secondErrors: string[] = [];
      secondPage.on("pageerror", (error) => secondErrors.push(error.message));
      await secondPage.goto(`${origin}/?pane=${encodeURIComponent(second)}`);
      await secondPage.locator(".conn-live").waitFor();
      await secondPage.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);

      // Both pages begin without a split; each then stores a different one in the same context.
      await splitRight(firstPage, firstOther);
      await settled(firstPage);
      await splitRight(secondPage, secondOther);
      await settled(secondPage);

      await firstPage.reload();
      await firstPage.locator(".conn-live").waitFor();
      await firstPage.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await half(firstPage, "left").getByRole("log", { name: `conversation of ${first}`, exact: true }).waitFor();
      await half(firstPage, "right").getByRole("log", { name: `conversation of ${firstOther}`, exact: true }).waitFor();
      assert.equal(await firstPage.getByRole("log", { name: `conversation of ${secondOther}`, exact: true }).count(), 0,
        "reloading the first page restores its split instead of the second page's");
      assert.deepEqual(firstErrors, []);
      assert.deepEqual(secondErrors, []);
      console.log("PASS split state is isolated per page in a shared browser context");
    }

    // 8. Only a primary non-context press activates an inactive half, including on macOS.
    {
      const [left, right] = await panesFor("pointer-left", "pointer-right") as [string, string];
      const { page, errors } = await open([left, right], "terminal", undefined, { platform: "MacIntel" });
      await splitRight(page, right);
      for (const press of [
        { button: 2, ctrlKey: false, name: "right press" },
        { button: 1, ctrlKey: false, name: "middle press" },
        { button: 0, ctrlKey: true, name: "macOS Control-click" },
      ]) {
        await half(page, "left").locator(".terminal-host").dispatchEvent("pointerdown", {
          button: press.button, ctrlKey: press.ctrlKey, pointerId: 1, pointerType: "mouse", isPrimary: true,
        });
        await settled(page);
        assert.equal(await half(page, "right").evaluate((slot) => slot.classList.contains("is-active")), true,
          `${press.name} does not activate the inactive half`);
      }
      assert.deepEqual(errors, []);
      console.log("PASS right, middle and macOS Control-click presses leave the other half active");
    }

    // 9. An inactive-half lens choice is live in memory even when its storage write fails.
    {
      const [left, right] = await panesFor("lens-left", "lens-right") as [string, string];
      const { page, errors } = await open([left, right], "chat", undefined, { blockViewWrites: true });
      await splitRight(page, right);
      await half(page, "left").getByRole("button", { name: "Show the terminal", exact: true }).click();
      await settled(page);
      assert.equal(await half(page, "left").locator(".pane-slot-action").first().getAttribute("aria-label"), "Show the chat",
        "the inactive half reflects its explicit terminal choice");
      assert.equal(await page.evaluate((pane) => localStorage.getItem(`herdr-web-ui:view:${pane}`), left), "chat",
        "the fixture's stored value remains unchanged after the blocked write");
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await settled(page);
      assert.equal(await page.locator('.view-switch button[aria-pressed="true"]').innerText(), "Terminal",
        "activating the half keeps the in-memory lens choice");
      assert.deepEqual(errors, []);
      console.log("PASS an inactive-half lens choice works and survives activation when storage writes fail");
    }

    // 10. The phone's glass header follows the nested pane DOM, but never crosses a notice or tab row.
    {
      const [pane] = await panesFor("mobile-glass") as [string];
      const { page, errors } = await open([pane], "chat");
      await page.setViewportSize({ width: 700, height: 500 });
      await page.evaluate(() => {
        const app = document.createElement("div");
        app.id = "split-css-fixture";
        app.className = "app";
        app.style.cssText = "position:absolute;left:-2px;top:-2px;width:1px;height:1px;visibility:hidden;pointer-events:none";
        const header = document.createElement("header");
        header.className = "app-header";
        const body = document.createElement("div");
        body.className = "app-body";
        const column = document.createElement("div");
        column.className = "pane-column is-chat";
        const split = document.createElement("div");
        split.className = "pane-split";
        const slot = document.createElement("div");
        slot.className = "pane-slot";
        const host = document.createElement("main");
        host.className = "terminal-host";
        slot.append(host);
        split.append(slot);
        column.append(split);
        body.append(column);
        app.append(header, body);
        document.body.append(app);
      });
      const glassState = () => page.locator("#split-css-fixture").evaluate((app) => ({
        over: getComputedStyle(app).getPropertyValue("--header-over").trim(),
        margin: getComputedStyle(app.querySelector(".app-header")!).marginBottom,
      }));
      const initialGlass = await glassState();
      assert.notEqual(initialGlass.over, "", "the nested pane host enables phone glass-header overlap");
      assert.ok(Number.parseFloat(initialGlass.margin) < 0, "the header overlaps the chat when no row comes first");

      await page.locator("#split-css-fixture .pane-column").evaluate((column) => {
        const notice = document.createElement("p");
        notice.className = "pane-notice";
        notice.textContent = "Synthetic notice";
        column.insertBefore(notice, column.firstElementChild);
      });
      const noticeState = await glassState();
      assert.equal(noticeState.over, "", "a visible notice keeps the header in flow");
      assert.notEqual(await page.locator("#split-css-fixture .pane-notice").evaluate((notice) => getComputedStyle(notice).display), "none",
        "the notice remains visible");

      await page.locator("#split-css-fixture .pane-notice").evaluate((notice) => notice.remove());
      await page.locator("#split-css-fixture .pane-slot").evaluate((slot) => {
        const tabs = document.createElement("div");
        tabs.className = "tab-strip";
        slot.insertBefore(tabs, slot.firstElementChild);
      });
      const tabState = await glassState();
      assert.equal(tabState.over, "", "a visible tab strip keeps the header in flow");
      assert.notEqual(await page.locator("#split-css-fixture .tab-strip").evaluate((tabs) => getComputedStyle(tabs).display), "none",
        "the tab strip remains visible");
      assert.deepEqual(errors, []);
      console.log("PASS phone glass-header selectors follow pane-slot nesting without covering notices or tabs");
    }

    // A saved partner on a removed PC is discarded only after the roster arrives.
    {
      const [pane] = await panesFor("removed-machine") as [string];
      const { page, errors } = await open([pane], "chat", (context) => context.addInitScript(() => {
        sessionStorage.setItem("herdr-web-ui:split", JSON.stringify({
          other: { machineId: "removed-split-fixture", paneId: "missing-pane" },
          bSide: "right", active: "a",
        }));
      }));
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1
        && sessionStorage.getItem("herdr-web-ui:split") === null);
      await page.getByRole("log", { name: `conversation of ${pane}`, exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a saved split on a removed PC closes after the roster arrives");
    }
  } finally {
    for (const context of contexts) await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
