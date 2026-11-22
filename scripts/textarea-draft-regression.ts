import assert from "node:assert/strict";
import type { Browser, Locator } from "playwright-core";

export async function checkTextareaDrafts(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await context.addInitScript((ids) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
      for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
    }, [pane, otherPane]);
    const page = await context.newPage();
    const sent: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (["input", "insert", "submit"].includes(message.type)) sent.push(message.type);
    }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const chat = page.getByRole("textbox", { name: "Message", exact: true });
    const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
    const view = (name: string) => page.locator(".view-switch").getByRole("button", { name, exact: true }).click();
    const select = (id: string) => page.locator(`.pane-select[title^="${id} —"]`).click();
    const frame = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const cdp = await context.newCDPSession(page);

    async function replay(box: Locator, event: "compositionend" | "input", value = "abcdef", caret = value.length) {
      return box.evaluate((node: HTMLTextAreaElement, { event, value, caret }) => {
        node.focus();
        if (event === "compositionend") node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        // Use the element setter, which also updates React's value tracker.
        node.value = value;
        node.setSelectionRange(caret, caret);
        if (event === "compositionend") node.dispatchEvent(new CompositionEvent(event, { bubbles: true, data: "abcdef" }));
        else node.dispatchEvent(new InputEvent(event, { bubbles: true, inputType: "insertText", data: "abcdef" }));
        const beforeKeyup = node.value;
        node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
        return beforeKeyup;
      }, { event, value, caret });
    }

    const results: Record<string, string[]> = {};
    for (const event of ["compositionend", "input"] as const) {
      await chat.fill("");
      const before = await replay(chat, event);
      await frame();
      const after = await chat.inputValue();
      await view("Terminal");
      await line.fill("");
      const terminalBefore = await replay(line, event);
      await view("Chat");
      await line.waitFor({ state: "detached" });
      await view("Terminal");
      results[event] = [before, after, terminalBefore, await line.inputValue()];
      await view("Chat");
    }
    console.log("Textarea drafts [Chat before/after rerender, Terminal before/after remount]:", JSON.stringify(results));
    assert.deepEqual(results, {
      compositionend: ["abcdef", "abcdef", "abcdef", "abcdef"],
      input: ["abcdef", "abcdef", "abcdef", "abcdef"],
    });

    for (const [name, box] of [["Chat", chat], ["Terminal", line]] as const) {
      await view(name);
      await box.fill("left old right");
      await box.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 8));
      await replay(box, "compositionend", "left abcdef right", 11);
      // A browser can deliver the final input after compositionend.
      await box.dispatchEvent("input", { inputType: "insertCompositionText", data: "abcdef" });
      await frame();
      assert.equal(await box.inputValue(), "left abcdef right", `${name}: a repeated commit does not duplicate a replacement`);
      assert.equal(await box.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 11, `${name}: caret stays after the replacement`);

      await box.fill("");
      await box.focus();
      await page.keyboard.type("typed ");
      await page.evaluate(() => navigator.clipboard.writeText("pasted"));
      await page.keyboard.press("ControlOrMeta+v");
      assert.equal(await box.inputValue(), "typed pasted", `${name}: typing and clipboard paste are retained`);
      await box.blur();
      await box.focus();
      await cdp.send("Input.insertText", { text: " late" });
      assert.equal(await box.inputValue(), "typed pasted late", `${name}: input after refocus is retained`);

      await cdp.send("Input.imeSetComposition", { text: "取消", selectionStart: 2, selectionEnd: 2 });
      assert.equal(await box.inputValue(), "typed pasted late取消", `${name}: Chromium shows the composition`);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      assert.equal(await box.inputValue(), "typed pasted late", `${name}: cancel restores the draft`);
      await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
      await cdp.send("Input.insertText", { text: "日本語" });
      assert.equal(await box.inputValue(), "typed pasted late日本語", `${name}: Chromium commits the final candidate once`);
      const saved = await box.inputValue();
      const old = await box.elementHandle();
      await old.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await select(otherPane);
      if (name === "Terminal") await view("Terminal");
      await box.fill("other pane");
      await old.evaluate((node: HTMLTextAreaElement) => {
        node.value = "late from the previous pane";
        node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: node.value }));
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: node.value }));
      });
      await old.dispose();
      assert.equal(await box.inputValue(), "other pane", `${name}: a late commit cannot overwrite the selected pane`);
      await select(pane);
      assert.equal(await box.inputValue(), saved, `${name}: a late commit cannot overwrite the previous pane`);
      console.log(`PASS ${name} preserves typing, paste, IME commit/cancel, caret and pane ownership`);
    }
    assert.deepEqual(sent, [], "editing an unsent draft never sends input");
  } finally {
    await context.close();
  }
}
