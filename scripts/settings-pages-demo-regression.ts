import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsPage } from "./settings-page.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import { terminalTheme } from "../src/lib/settings.ts";
import { THEME_IDS, type ThemeId } from "../src/lib/themes.ts";
import baseline from "../src/lib/themes.legacy-baseline.json";
import { comboKey, LEGACY_COMBOS } from "./theme-baseline.ts";

// Settings on the unmodified app over the demo's fixture transport: every page fits a phone, and
// the browser's Back button steps out of the dialog instead of out of the app. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const PAGES = ["Appearance", "Chat", "Terminal", "Alerts", "Voice input", "Subscription usage", "Shortcuts", "Phone & devices", "Remote PCs", "Agent integrations", "About"];
const SETTINGS = { language: "en", showUsage: true, voiceInput: true, showQuickReplies: true, fileOpen: "panel" };

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const openSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
};
/** The Settings entry of the current history state, as the app wrote it. */
const entryOf = (page: Page): Promise<{ page: string | null; keyBar: boolean; depth: number } | null> =>
  page.evaluate(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] as never ?? null);
/** Waits for the history to hold what a step left; a wait that runs out says what it holds instead, and how it came to. */
const historyHolds = async (page: Page, step: string, holds: () => boolean): Promise<void> => {
  try { await page.waitForFunction(holds); }
  catch (error) {
    const seen = await page.evaluate(() => ({ state: history.state as unknown, address: location.search, dialogs: document.querySelectorAll(".settings-dialog").length, trace: (window as unknown as { historyTrace?: string[] }).historyTrace?.slice(-40) }));
    throw new Error(`${step}: the history never held it. ${JSON.stringify(seen, null, 1)}`, { cause: error });
  }
};
/** Controls and text that reach past their card, and cards past the page's box: a row wider than its card is cut there. */
const cutOff = (page: Page): Promise<string[]> => page.locator(".settings-body:not([hidden]), .settings-key-bar-body").evaluate((body) => {
  const edge = body.getBoundingClientRect();
  const out = [...body.querySelectorAll<HTMLElement>("button, input, select, a, .settings-card, .settings-row")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      // a control is held by its card, where it has one; a card by the page
      const card = node.classList.contains("settings-card") ? null : node.closest<HTMLElement>(".settings-card");
      const within = card ? card.getBoundingClientRect() : edge;
      return box.width > 0 && (box.right > within.right + 0.5 || box.left < within.left - 0.5);
    })
    .map((node) => `${node.tagName.toLowerCase()}.${node.className} ${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30) ?? ""}`);
  return body.scrollWidth > body.clientWidth ? [`the page scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`, ...out] : out;
});

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const [width, language] of [[390, "en"], [320, "en"], [320, "ko"], [320, "ja"], [320, "zh"]] as const) {
        const started = performance.now();
        const strings: Record<string, string> = language === "ko" ? KO : language === "ja" ? JA : language === "zh" ? ZH : {};
        const label = (name: string): string => strings[name] ?? name;
        const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, locale: language });
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
          await context.addInitScript((settings) => { if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", settings); }, JSON.stringify({ ...SETTINGS, language }));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const terminal = page.locator(".pane-terminal");
          await terminal.waitFor({ state: "attached" });
          const lens = page.getByRole("group", { name: "Pane view", exact: true });
          await lens.getByTitle(label("Live terminal (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), "region");
          assert.equal(await terminal.getAttribute("aria-roledescription"), label("Terminal"));
          assert.equal(await terminal.getAttribute("aria-label"), label("Terminal for {title}").replace("{title}", "Idempotent payments"));
          assert.equal(await terminal.getAttribute("tabindex"), null, "the wrapper adds no empty keyboard stop");
          await lens.getByTitle(label("Chat transcript (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), null, "chat exposes no empty terminal landmark");
          assert.equal(await terminal.getAttribute("aria-label"), null);
          await openSettings(page);
          for (const name of PAGES) {
            await openSettingsPage(page, label(name), label("Back to settings"));
            // what a page asks the server for (devices, the phone address, the accounts) has arrived
            await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")),
              [label("Loading…"), label("Asking this PC about Tailscale…")]);
            if (name === "Subscription usage") await page.locator(".usage-accounts-row").first().waitFor();
            if (name === "Voice input") {
              await page.locator(".voice-key").waitFor();
              const dictation = page.getByLabel(label("Dictation language"), { exact: true });
              await dictation.selectOption("hu-HU");
              await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).voiceLanguage === "hu-HU");
              assert.equal(await dictation.inputValue(), "hu-HU");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).language), language,
                "dictation selection does not change the display language");
              await dictation.selectOption("auto");
            }
            if (name === "Agent integrations") {
              // the demo's fixture, in herdr's order with the agents found on the PC first: a failed request
              // would leave one error paragraph that still fits, so the rows and their states are asserted
              const body = page.locator(".settings-body:not([hidden])");
              assert.equal(await body.locator("[role='alert']").count(), 0, "the integrations page shows no error");
              const install = (target: string): string => `herdr integration install ${target}`;
              const shown = await body.locator(".settings-row").evaluateAll((nodes) => nodes.map((node) => ({
                label: node.querySelector(".settings-label")?.textContent ?? "",
                description: node.querySelector(".settings-description")?.textContent ?? "",
                command: node.querySelector("code")?.textContent ?? null,
                copy: node.querySelector("button")?.getAttribute("aria-label") ?? null,
              })));
              const copyLabel = (target: string): string => label("Copy the command for {name}").replace("{name}", target);
              const missing = label("Not installed");
              assert.deepEqual(shown, [
                // the launch modes for new Claude Code and Codex agents lead the page
                { label: "Claude Code", description: label("Permission mode"), command: null, copy: null },
                { label: "Codex", description: label("Sandbox and approvals"), command: null, copy: null },
                { label: "pi", description: missing + install("pi"), command: install("pi"), copy: copyLabel("pi") },
                { label: "claude", description: label("Installed"), command: null, copy: null },
                { label: "codex", description: label("Installed, but older than this herdr: run this to update it") + install("codex"), command: install("codex"), copy: copyLabel("codex") },
                { label: "opencode", description: missing + install("opencode"), command: install("opencode"), copy: copyLabel("opencode") },
                { label: "omp", description: missing + install("omp"), command: install("omp"), copy: copyLabel("omp") },
                { label: "copilot", description: missing + install("copilot"), command: install("copilot"), copy: copyLabel("copilot") },
                { label: "cursor", description: missing + install("cursor"), command: install("cursor"), copy: copyLabel("cursor") },
                { label: "antigravity-cli", description: missing + install("antigravity-cli"), command: install("antigravity-cli"), copy: copyLabel("antigravity-cli") },
              ], "every fixture integration, with its state and install command");
              assert.deepEqual(await body.locator("h3").allTextContents(), [label("New agents"), label("Not found on this PC")]);
              const copy = body.getByRole("button", { name: copyLabel("codex"), exact: true });
              await copy.tap();
              await body.getByRole("button", { name: copyLabel("codex"), exact: true }).filter({ hasText: label("Copied") }).waitFor();
              assert.equal(await page.evaluate(() => navigator.clipboard.readText()), install("codex"));
            }
            if (name === "Appearance" && language === "en") {
              // each legacy palette-mode is written to the document and saved, and its blocks of styles.css
              // reach the page: every color token computes to the frozen baseline's used value
              // (src/lib/themes.legacy-baseline.json), and the --term-* tokens to the theme xterm is given.
              // The build minifies colors (rgba() to #rrggbbaa), so both sides are compared as the browser
              // computes them on a probe: a color, a box-shadow, or a border for `2px solid <color>`
              const themes = page.getByRole("group", { name: "Theme", exact: true });
              const pickers = { dark: page.locator("#settings-theme-dark"), light: page.locator("#settings-theme-light") };
              // both pickers offer every theme, grouped by kind with the side's own kind first (Q1: any theme on either side)
              for (const side of ["dark", "light"] as const) {
                const listed = await pickers[side].locator("option").evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
                assert.deepEqual([...listed].sort(), [...THEME_IDS].sort(), `the ${side} picker lists every theme once`);
                assert.ok(listed.includes("dracula"), `the ${side} picker offers Dracula`);
                assert.deepEqual(await pickers[side].locator("optgroup").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("label"))), side === "dark" ? ["Dark", "Light"] : ["Light", "Dark"]);
              }
              const drawn = (mode: string, id: string): Promise<unknown> => page.waitForFunction(([mode, id]) => document.documentElement.dataset.theme === mode && document.documentElement.dataset.palette === id && getComputedStyle(document.documentElement).colorScheme === mode, [mode, id]);
              /** The theme keys of the saved record and of the second key old code never touches. */
              const stored = () => page.evaluate(() => {
                const record = JSON.parse(localStorage.getItem("herdr-web-ui:settings")!) as Record<string, string>;
                const themes = JSON.parse(localStorage.getItem("herdr-web-ui:themes")!) as Record<string, string>;
                return { palette: record["palette"], darkTheme: record["darkTheme"], lightTheme: record["lightTheme"], second: { darkTheme: themes["darkTheme"], lightTheme: themes["lightTheme"] } };
              });
              const xtermTokens = (mode: "dark" | "light", id: ThemeId): (readonly [string, string])[] => {
                const xterm = terminalTheme(mode, id);
                return ([["--term-bg", xterm.background], ["--term-fg", xterm.foreground], ["--term-cursor", xterm.cursor], ["--term-selection", xterm.selectionBackground]] as const).map(([name, value]) => [`xterm ${name}`, value] as const);
              };
              /** The expected tokens the page computes differently, as `name: want -> got`. */
              const drift = (expected: (readonly [string, string])[]): Promise<string[]> => page.evaluate((expected) => {
                const root = getComputedStyle(document.documentElement);
                const probe = document.body.appendChild(document.createElement("div"));
                const used = (value: string): string => {
                  const kind = /\bsolid\b/.test(value) ? "border" : /\dpx\b/.test(value) ? "boxShadow" : "color";
                  probe.removeAttribute("style");
                  probe.style[kind] = value;
                  if (probe.style[kind] === "") return `invalid ${kind}: ${value}`;
                  const style = getComputedStyle(probe);
                  return kind === "border" ? `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` : style[kind];
                };
                const out = expected.flatMap(([name, value]) => {
                  const [want, got] = [used(value), used(root.getPropertyValue(name.replace(/^xterm /, "")))];
                  return want === got ? [] : [`${name}: ${want} -> ${got}`];
                });
                probe.remove();
                return out;
              }, expected);
              const combos: Record<string, { resolved: Record<string, string> }> = baseline.combos;
              for (const { palette: id, mode } of LEGACY_COMBOS) {
                const key = comboKey(id, mode);
                await themes.getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).tap();
                await pickers[mode].selectOption(id);
                await drawn(mode, id);
                assert.equal((await stored()).palette, id);
                assert.deepEqual(await drift([...Object.entries(combos[key]!.resolved), ...xtermTokens(mode, id)]), [], `${key}: the page computes the frozen colors, and --term-* as the theme xterm is given`);
                if (key === "catppuccin/dark" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `catppuccin-palette-${width}.png`), fullPage: true });
              }
              // a herdr pair: Tokyo Night on the dark side fills the untouched light side with Tokyo Night Day, each
              // side draws its own row with its xterm colors, and the look follows the mode toggle
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.light.selectOption("amber");
              await pickers.dark.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" } }, "a paired dark theme fills the light side still at its default with its sibling");
              assert.equal(await pickers.light.inputValue(), "tokyo-night-day");
              assert.deepEqual(await drift(xtermTokens("dark", "tokyo-night")), [], "tokyo-night/dark: --term-* as the theme xterm is given");
              await themes.getByRole("button", { name: "Light", exact: true }).tap();
              await drawn("light", "tokyo-night-day");
              assert.equal((await stored()).palette, "tokyo-night-day", "the legacy palette mirrors the side the mode draws");
              assert.deepEqual(await drift(xtermTokens("light", "tokyo-night-day")), [], "tokyo-night-day/light: --term-* as the theme xterm is given");
              // any theme on either side (Q1): a dark theme picked for the light side draws dark in Light mode
              await pickers.light.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night" } }, "a dark theme on the light side is kept as chosen");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).theme), "light", "the mode stays Light while the row drawn is dark");
              // a side chosen by hand keeps its theme when the other side picks a pair
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.dark.selectOption("gruvbox");
              await drawn("dark", "gruvbox");
              assert.deepEqual(await stored(), { palette: "gruvbox", darkTheme: "gruvbox", lightTheme: "tokyo-night", second: { darkTheme: "gruvbox", lightTheme: "tokyo-night" } }, "a light side chosen by hand is not filled with the pair's sibling");
              // the pages after this one are checked on the default theme
              await pickers.dark.selectOption("amber");
              await pickers.light.selectOption("amber");
              await drawn("dark", "amber");
            }
            assert.deepEqual(await cutOff(page), [], `${name} fits a ${width}px phone (${language})`);
          }
          await openSettingsPage(page, label("Terminal"), label("Back to settings"));
          await page.getByRole("button", { name: label("Edit key bar"), exact: true }).tap();
          await page.locator(".key-bar-settings").waitFor();
          assert.deepEqual(await cutOff(page), [], `Key bar fits a ${width}px phone (${language})`);
          await page.getByRole("button", { name: label("Back to settings"), exact: true }).tap();
          // the quick replies are text fields beside a Remove button each: both stay in the card
          if (language === "en") {
            await openSettingsPage(page, "Chat");
            const replies = page.locator(".quick-replies-list li");
            assert.ok(await replies.count() > 0);
            await page.getByRole("button", { name: "Remove quick reply 1", exact: true }).tap();
            assert.equal(await replies.count(), (JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:settings")!)) as { quickReplies: string[] }).quickReplies.length);
            await page.getByRole("button", { name: "Restore defaults", exact: true }).tap();
          }
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: label("Close settings"), exact: true }).tap();
          if (language === "en") {
            const composer = page.locator(".composer-text");
            await composer.fill("/");
            const menu = page.getByRole("listbox", { name: "Slash commands" });
            await menu.getByRole("option").last().waitFor();
            await composer.press("ArrowUp");
            await page.waitForFunction(() => {
              const menu = document.querySelector(".composer-menu");
              const active = menu?.querySelector('[aria-selected="true"]');
              if (!menu || !active) return false;
              const box = menu.getBoundingClientRect(), row = active.getBoundingClientRect();
              return active.textContent?.includes("vim") && row.top >= box.top && row.bottom <= box.bottom;
            });
            // Enter right after the keystroke that narrows the list, before React's next render, completes the row
            await page.evaluate(async () => {
              const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "/comments");
              box.selectionStart = box.selectionEnd = box.value.length;
              box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              await Promise.resolve(); await Promise.resolve();
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.press("Tab");
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            assert.equal(await composer.inputValue(), "/pr-comments ");
            // a key typed after a completion, before the next frame (a busy phone), stays where it was typed
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            await page.evaluate(() => {
              const real = window.requestAnimationFrame, held: FrameRequestCallback[] = [];
              window.requestAnimationFrame = (callback) => { held.push(callback); return 0; };
              addEventListener("release-frames", () => {
                window.requestAnimationFrame = real;
                for (const callback of held) callback(performance.now());
              }, { once: true });
            });
            await composer.press("Tab");
            await page.keyboard.type("a");
            await page.evaluate(() => dispatchEvent(new Event("release-frames")));
            await page.keyboard.type("b");
            assert.equal(await composer.inputValue(), "/pr-comments ab");
            await composer.fill("/rln");
            await menu.getByRole("option").filter({ hasText: "release-notes" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.fill("");
            console.log(`PASS fuzzy commands and offscreen keyboard selection (${width}px)`);
          }
          console.log(`PASS every Settings page and key bar fit a ${width}px phone (${language}); ${(performance.now() - started).toFixed(0)}ms`);
        } finally {
          await context.close();
        }
      }

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript((settings) => localStorage.setItem("herdr-web-ui:settings", settings), JSON.stringify(SETTINGS));
        // every move of the history, for historyHolds to tell when a step never lands
        await phone.addInitScript(() => {
          const trace: string[] = [];
          (window as unknown as { historyTrace: string[] }).historyTrace = trace;
          const note = (what: string): void => { trace.push(`${Math.round(performance.now())}ms ${what} ${JSON.stringify(history.state)} ${location.search}`); };
          for (const method of ["go", "back", "pushState", "replaceState"] as const) {
            const call = (history[method] as (...args: unknown[]) => void).bind(history);
            (history as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { note(`before ${method}(${method === "go" ? String(args[0]) : ""})`); call(...args); note(`after ${method}`); };
          }
          addEventListener("popstate", () => note("popstate"), true);
          note("loaded");
        });
        // a load that was asked to hold its steps back keeps them until the app has drawn itself, as a
        // slow device does, and notes whether Settings was ever shown
        await phone.addInitScript(() => {
          if (sessionStorage.getItem("hold-steps-back") !== "1") return;
          sessionStorage.removeItem("hold-steps-back");
          const page = window as unknown as { releaseStepsBack: () => void; settingsShown: boolean };
          const go = history.go.bind(history);
          const held: Array<() => void> = [];
          history.go = (delta?: number) => { held.push(() => go(delta)); };
          page.releaseStepsBack = () => { history.go = go; for (const step of held.splice(0)) step(); };
          page.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) page.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const dialog = dialogOf(page);
        const list = dialog.getByRole("tablist");

        // Back steps out one screen at a time: the key bar editor, the page, the list, and only then nothing.
        // The address names the pane shown (lib/deepLink.ts) once the roster is in: that is where Back returns
        await page.waitForFunction(() => new URLSearchParams(window.location.search).has("pane"));
        const before = page.url();
        await openSettings(page);
        assert.deepEqual(await entryOf(page), { page: null, keyBar: false, depth: 1 });
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        assert.deepEqual(await entryOf(page), { page: "terminal", keyBar: true, depth: 3 });
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0);
        await page.goBack();
        await list.waitFor();
        assert.equal(await dialog.getByRole("tabpanel").count(), 0, "Back from a page shows the list again");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        assert.equal(await entryOf(page), null);
        assert.equal(page.url(), before, "the last Back closes Settings and leaves the app where it was");
        await page.locator(".conn-live").waitFor({ state: "attached" });
        console.log("PASS Back on a phone leaves the key bar editor, then the page, then the list, and stays in the app");

        // the dialog's own Back control takes the same entry off: the next Back is not spent on it
        await openSettings(page);
        await openSettingsPage(page, "Chat");
        await dialog.getByRole("button", { name: "Back to settings", exact: true }).tap();
        await list.waitFor();
        await historyHolds(page, "the Back control to the list", () => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        console.log("PASS the Back control in the dialog and the system Back button share one history");

        // closing from the deepest screen leaves no entry behind, and Forward does not reopen what the X closed by itself
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("button", { name: "Close settings", exact: true }).tap();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await historyHolds(page, "the X from the key bar editor", () => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        // and a new opening starts on the list, with one entry
        await openSettings(page);
        await list.waitFor();
        await historyHolds(page, "a new opening", () => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 1);
        // a reload keeps the history but not the dialog: its entries are stepped out of. The step lands
        // when the browser gets to it, which on a slow device is after the app has drawn itself from an
        // address that still names Settings: held back until then here, it must not show the dialog
        await openSettingsPage(page, "Alerts");
        await page.waitForFunction(() => new URLSearchParams(window.location.search).get("settings") === "alerts");
        await page.evaluate(() => sessionStorage.setItem("hold-steps-back", "1"));
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.evaluate(() => (window as unknown as { releaseStepsBack: () => void }).releaseStepsBack());
        await historyHolds(page, "the reload", () => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "a reload never shows Settings, however late its step back lands");
        assert.deepEqual(errors, []);
        console.log("PASS the X from the key bar editor and a reload leave no Settings entry in the history");

        // a link to Settings opens it, and a reload there closes it as well: the entry the reload
        // steps back to is the one the link opened, whose address names Settings still
        await page.goto(`${url}?settings=about`);
        await dialog.getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await historyHolds(page, "a link to Settings", () => (history.state as Record<string, { page: string; depth: number }> | null)?.["herdr-web-ui:settings"]?.page === "about");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await historyHolds(page, "the reload on a linked Settings", () => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined && !new URLSearchParams(window.location.search).has("settings"));
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload closes the Settings a link opened");
        assert.deepEqual(errors, []);
        console.log("PASS a link to Settings opens it, and a reload there closes it");

        // another script's entries pushed while Settings is open bury its entries: Back out of them
        // closes Settings, and the next Back steps over the buried entries instead of opening them again
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar editor", () => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 3);
        await page.evaluate(() => { history.pushState({ route: "markerless" }, ""); history.pushState({ route: "after-markerless" }, ""); });
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.evaluate(() => {
          const seen = window as unknown as { settingsShown: boolean };
          seen.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) seen.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        await page.goBack();
        await historyHolds(page, "Back over the buried entries", () => {
          const state = history.state as Record<string, unknown> | null;
          return state?.["herdr-web-ui:settings"] === undefined && state?.["route"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back under an unrelated entry does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "the buried entries are stepped over without showing Settings");
        assert.deepEqual(errors, []);
        console.log("PASS Back past an unrelated entry steps over the Settings entries it buried");
      } finally {
        await phone.close();
      }

      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((settings) => {
          if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", settings);
        }, JSON.stringify(SETTINGS));
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        for (const id of ["dracula", "nord", "vesper"]) {
          await openSettings(page);
          await openSettingsPage(page, "Appearance");
          await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Dark", exact: true }).click();
          await page.locator("#settings-theme-dark").selectOption(id);
          await page.waitForFunction((id) => document.documentElement.dataset.palette === id && document.documentElement.dataset.theme === "dark", id);
          assert.equal(await page.locator("#settings-theme-light").inputValue(), "amber", `${id} has no sibling pre-fill`);
          const surfaces = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return ["--border", "--bg-elevated", "--bg-input"].map((role) => style.getPropertyValue(role).trim());
          });
          assert.notEqual(surfaces[0], surfaces[1], `${id} border differs from elevated surface`);
          assert.notEqual(surfaces[0], surfaces[2], `${id} border differs from input surface`);
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-appearance-1280.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await page.locator(".composer-text").waitFor();
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-chat-1280.png`), animations: "disabled" });
        }
        await openSettings(page);
        await openSettingsPage(page, "Appearance");
        await page.locator("#settings-theme-light").selectOption("dracula");
        await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula" && document.documentElement.dataset.theme === "dark" && getComputedStyle(document.documentElement).colorScheme === "dark");
        assert.equal(await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"), "true");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).theme), "light");
        if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "dracula-light-side-1280.png"), animations: "disabled" });
        await page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings")!);
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, theme: "light", lightTheme: "not-a-theme" }));
          localStorage.setItem("herdr-web-ui:themes", JSON.stringify({ darkTheme: "vesper", lightTheme: "not-a-theme" }));
        });
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.documentElement.dataset.palette === "codex" && document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).colorScheme === "light");
        if (process.env.UI_EVIDENCE_DIR) writeFileSync(join(process.env.UI_EVIDENCE_DIR, "any-side.txt"), "PASS Light mode with lightTheme=dracula draws data-theme=dark, data-palette=dracula, color-scheme=dark.\nPASS injected lightTheme=not-a-theme reloads codex light, the default.\nPASS Dracula, Nord and Vesper do not pre-fill a sibling.\n");
        console.log("PASS dark-only themes on either side, distinct borders, no siblings, and unknown-id reload");
        await openSettings(page);
        // beside the list, turning pages is one step however many are turned
        for (const name of ["Chat", "Shortcuts", "About"]) await openSettingsPage(page, name);
        await page.waitForFunction(() => (history.state as Record<string, { page: string; depth: number }> | null)?.["herdr-web-ui:settings"]?.page === "about");
        assert.equal((await entryOf(page))?.depth, 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Forward opens it where it was
        await page.goForward();
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS on a desktop Back closes Settings in one step, Forward reopens its page, Escape takes the entry off");

        // the window changes width with Settings open: the steps Back takes are the ones now shown
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["herdr-web-ui:settings"]?.depth === 2);
        await page.goBack();
        await dialogOf(page).getByRole("tablist").waitFor();
        assert.equal(await dialogOf(page).getByRole("tabpanel").count(), 0, "narrowed, Back from the page shows the list");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialogOf(page).getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await page.setViewportSize({ width: 1280, height: 800 });
        // the rebuilt stack, not the step the widening passes through
        await page.waitForFunction(() => { const entry = (history.state as Record<string, { page: string; keyBar: boolean; depth: number }> | null)?.["herdr-web-ui:settings"]; return entry?.depth === 2 && entry.page === "terminal" && entry.keyBar === true; });
        await page.goBack();
        await dialogOf(page).getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0, "widened, Back from the editor shows the Terminal page");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS a window that changes width with Settings open keeps Back to the steps it shows");

        // a link to a file and Settings opens the preview (a panel beside the pane at this width) under
        // Settings; a reload there closes Settings and keeps the file, and Back then steps out of both
        const infra = panes.omp;
        await page.goto(`${url}?ws=${infra.split(":")[0]}&pane=${encodeURIComponent(infra)}&file=README.md&settings=about`);
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "a link to a file and Settings", () => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:file-preview"] !== undefined);
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "the reload on a preview over Settings", () => {
          const address = new URLSearchParams(window.location.search);
          return address.get("file") === "README.md" && !address.has("settings") && (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload on a preview over Settings closes Settings");
        assert.equal(await page.locator("aside.file-panel .file-viewer").count(), 1, "a reload on a preview over Settings keeps the file open");
        await page.goBack();
        await page.locator("aside.file-panel .file-viewer").waitFor({ state: "detached" });
        await historyHolds(page, "Back from the reloaded preview", () => (history.state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back from the reloaded preview does not reopen Settings");
        assert.deepEqual(errors, []);
        console.log("PASS a reload on a preview opened over Settings closes Settings and keeps the file");
      } finally {
        await desktop.close();
      }
    } finally {
      await browser.close();
      console.log("CLEANUP browser closed");
    }
  } finally {
    server.stop(true);
    console.log("CLEANUP loopback demo server stopped");
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  console.log("CLEANUP disposable demo app removed");
}
