/** Replay the native Safari 26.6.2 trace from #432, not a claim to automate the OS IME. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

/** Replay Safari replacement edits and assert emitted bytes, commit order and pane isolation. */
export async function checkSafariIme(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.6.2 Safari/605.1.15",
    viewport: { width: 1100, height: 700 },
  });
  await context.addInitScript((pane) => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
    localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal");
  }, pane);
  const page = await context.newPage();
  const sent: Array<{ pane_id: string; text: string }> = [];
  let ready = false;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "input-ready") ready = frame.ready !== false;
      socket.send(raw);
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "input") sent.push(frame);
      else server.send(raw);
    });
  });
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, "Safari trace replay timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
  };
  const input = page.locator(".xterm-helper-textarea");
  const reset = async () => {
    ready = false;
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await until(() => ready);
    await input.focus();
    sent.length = 0;
  };
  // Safari 26.6.2 edits the DOM BEFORE keydown 229, with no composition events. Each
  // beforeinput selection is the range Safari replaces, including final consonants.
  // The keyCode and the keydown's place (before or after the edit) are parameters: the
  // recorded trace fixes them for typing, not for Backspace, Delete or punctuation.
  const edit = async (type: string, data: string, start: number, end = start, keyCode = 229, order: "after" | "before" = "after") => {
    await input.evaluate(async (element, { type, data, start, end, keyCode, order }) => {
      const box = element as HTMLTextAreaElement;
      const key = keyCode === 8 ? "Backspace" : keyCode === 46 ? "Delete" : data;
      const keydown = () => box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, keyCode, isComposing: false }));
      // A browser makes no DOM edit for a keydown that was cancelled before it.
      if (order === "after" || keydown()) {
        box.setSelectionRange(start, end);
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: type, data, isComposing: false }));
        box.setRangeText(data, start, end, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: type, data, isComposing: false }));
        if (order === "after") keydown();
      }
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key, keyCode: keyCode === 229 ? 71 : keyCode, isComposing: false }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, { type, data, start, end, keyCode, order });
  };
  const syllable = async (parts: string[], at = 0) => {
    await edit("insertText", parts[0]!, at);
    for (const part of parts.slice(1)) await edit("insertReplacementText", part, at, at + 1);
  };
  const check = async (expected: string, label: string) => {
    await input.press("Control+g");
    await until(() => sent.at(-1)?.text === "\x07");
    assert.equal(sent.map((frame) => frame.text).join(""), expected + "\x07", label);
    assert(sent.every((frame) => frame.pane_id === pane), "input stays with its pane");
  };
  try {
    await reset();
    await input.press("a"); await input.press("b"); await input.press("c");
    await syllable(["ㅎ", "하", "한"]);
    assert.equal(sent.map((frame) => frame.text).join(""), "abc", "provisional Hangul must stay local");
    await edit("insertReplacementText", "한", 0, 1);
    await syllable(["ㄱ", "그", "글"], 1);
    await edit("insertReplacementText", "글", 1, 2);
    await input.press("Space");
    await check("abc한글 ", "English prefix then Safari Hangul commits once, in order");

    for (const [key, expected] of [["Enter", "\r"], ["Shift+Enter", "\x1b\r"], ["Meta+Backspace", "\x15"], ["Meta+ArrowLeft", "\x01"], ["Meta+ArrowRight", "\x05"]]) {
      await reset(); await syllable(["ㅎ", "하", "한"]);
      await input.press(key!);
      await check("한" + expected, `Safari commit precedes ${key}`);
    }
    await reset(); await syllable(["ㄱ", "가", "갑", "값"]);
    await edit("insertReplacementText", "갑", 0, 1);
    await syllable(["사"], 1);
    await input.press("Space");
    await check("갑사 ", "moved final consonant comes from the corrected DOM");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await edit("insertReplacementText", "하", 0, 1);
    await edit("insertReplacementText", "ㅎ", 0, 1);
    await edit("deleteContentBackward", "", 0, 1);
    await input.press("a");
    await check("a", "deleting uncommitted Hangul sends no partial syllable or DEL");

    // Backspace and Delete may report their own keyCode, before or after Safari's edit.
    // Every case runs and every failure is reported together.
    const failures: string[] = [];
    const variant = async (run: () => Promise<void>) => {
      try { await run(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    };
    for (const order of ["after", "before"] as const) {
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("insertReplacementText", "하", 0, 1, 8, order);
        await edit("insertReplacementText", "한", 0, 1);
        await input.press("Space");
        await check("한 ", `Backspace keyCode 8 ${order} the edit stays inside the syllable`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ"]);
        await edit("deleteContentBackward", "", 0, 1, 8, order);
        await input.press("b");
        await check("b", `Backspace keyCode 8 ${order} emptying the preedit sends nothing`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("deleteContentForward", "", 0, 1, 46, order);
        await input.press("b");
        await check("b", `Delete ${order} removing the preedit sends nothing`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("insertText", ".", 1, 1, 229, order);
        await input.press("Space");
        await check("한. ", `punctuation with keydown 229 ${order} the edit follows the syllable`);
      });
    }
    assert.deepEqual(failures, [], failures.join("\n"));

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await input.evaluate((box) => (box as HTMLTextAreaElement).blur());
    await until(() => sent.length > 0);
    await input.focus();
    await check("한", "blur commits the last pending syllable once");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await input.evaluate((box) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "x");
      box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await input.press("Control+g");
    await until(() => sent.at(-1)?.text === "\x07");
    assert.deepEqual(sent.map((frame) => frame.text), ["한", sent[1]?.text, "\x07"]);
    assert(["x", "\x1b[200~x\x1b[201~"].includes(sent[1]!.text), "native paste follows the commit with its usual framing");

    await reset();
    await input.evaluate(async (element) => {
      const box = element as HTMLTextAreaElement;
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "한", isComposing: true }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "한", isComposing: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
    });
    await check("한", "real composition events on Safari keep the existing path");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    // A programmatic pane change does not blur first: reset must cancel pending text.
    ready = false;
    await page.locator(`.pane-select[title^="${otherPane} —"]`).first().evaluate((node: HTMLElement) => node.click());
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:selection")!).pane_id)) === otherPane);
    await until(() => ready);
    await input.press("Control+g");
    await until(() => sent.at(-1)?.text === "\x07");
    assert.equal(sent.map((frame) => frame.text).join(""), "\x07", "pending Safari text cannot enter another pane");
    console.log("PASS Safari native-event replay: English/Hangul, commit keys, final consonants, deletion, blur and pane reset");
  } finally { await context.close(); }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-safari-replay-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  const owned: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-safari-replay" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkSafariIme(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser?.close(); server.stop();
    for (const workspace of owned) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
